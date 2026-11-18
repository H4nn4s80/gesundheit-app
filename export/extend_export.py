"""Ergänzt ausschließlich vorhandene Snapshots, ohne Anbieterzugriff."""
import json
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
EXTRA=[('hrv','HRV · Nachtdurchschnitt','ms','Herz','line'),('bbhigh','Body Battery · Höchstwert','Punkte','Aktivität','line'),('bblow','Body Battery · Tiefstwert','Punkte','Aktivität','line'),('bbcharged','Body Battery · Ladung','Punkte','Aktivität','bar'),('vo2run','VO₂max · Laufen / allgemein','ml/kg/min','Aktivität','line'),('vo2row','VO₂max · Rudern','ml/kg/min','Aktivität','line'),('respawake','Atemfrequenz · wach','Atemzüge/min','Herz','line'),('respsleep','Atemfrequenz · Schlaf','Atemzüge/min','Schlaf','line'),('load','Akute Trainingslast','Punkte','Aktivität','line'),('chronic','Chronische Trainingslast','Punkte','Aktivität','line'),('acwr','ACWR','Verhältnis','Aktivität','line'),('visceral','Viszerales Fett','Index','Körpermaße','line'),('pwv','Pulswellengeschwindigkeit','m/s','Herz','line'),('vascular','Vaskuläres Alter','Jahre','Herz','line'),('nerve','Nervengesundheit','Punkte','Körpermaße','line')]
STATUS={'BALANCED':'Ausgeglichen','UNBALANCED':'Unausgeglichen','LOW':'Niedrig','POOR':'Schwach','NONE':'Nicht verfügbar','NO_DATA':'Keine Daten','UNKNOWN':'Unbekannt','OPTIMAL':'Optimal','HIGH':'Hoch','VERY_HIGH':'Sehr hoch'}
SPORTS={'indoor_cycling':'Indoor-Radfahren','indoor_rowing':'Indoor-Rudern','rowing':'Rudern','running':'Laufen','trail_running':'Traillauf','cycling':'Radfahren','e_bike_mountain':'E-Mountainbike','hiking':'Wandern','multi_sport':'Multisport','strength_training':'Krafttraining','walking':'Gehen','swimming':'Schwimmen','e_bike_fitness':'E-Bike','hiit':'HIIT','track_running':'Bahnlauf','treadmill_running':'Laufband','paddelball':'Padel'}
TE_LABELS={'AEROBIC_BASE':'Aerobe Basis','TEMPO':'Tempo','RECOVERY':'Erholung','ANAEROBIC_CAPACITY':'Anaerobe Kapazität','VO2MAX':'VO₂max','LACTATE_THRESHOLD':'Laktatschwelle','SPEED':'Schnelligkeit'}

TRAINING_PHRASES=[('UNPRODUCTIVE','Unproduktiv'),('PRODUCTIVE','Formaufbau'),('RECOVERY','Erholung'),('MAINTAINING','Formerhalt'),('DETRAINING','Formverlust'),('PEAKING','Höchstform'),('OVERREACHING','Überlastung'),('STRAINED','Belastet'),('PAUSED','Trainingspause')]
def training_status_de(phrase):
 phrase=phrase or ''
 for prefix,german in TRAINING_PHRASES:
  if phrase.startswith(prefix):return german
 return 'Nicht eingeordnet' if phrase else None
def _training_rows(blob,out=None,depth=0):
 """Collect dated training-status / load rows from any known Garmin payload shape. Never keep device/user ids."""
 if out is None:out=[]
 if blob is None or depth>6:return out
 if isinstance(blob,list):
  for item in blob:_training_rows(item,out,depth+1)
  return out
 if not isinstance(blob,dict):return out
 # A dated row
 day=blob.get('calendarDate') or blob.get('date') or blob.get('fromCalendarDate')
 acute=blob.get('acuteTrainingLoadDTO') or blob.get('trainingLoadDTO') or {}
 if not isinstance(acute,dict):acute={}
 # sometimes fields are at the top level
 for src in (blob,acute):
  if not isinstance(src,dict):continue
  if src.get('dailyTrainingLoadAcute') is not None or src.get('trainingStatusFeedbackPhrase') or src.get('trainingStatus'):
   if day:
    out.append({
     'date':day,
     'phrase':blob.get('trainingStatusFeedbackPhrase') or blob.get('trainingStatus') or blob.get('status') or '',
     'load':src.get('dailyTrainingLoadAcute', acute.get('dailyTrainingLoadAcute')),
     'chronic':src.get('dailyTrainingLoadChronic', acute.get('dailyTrainingLoadChronic')),
     'acwr':src.get('dailyAcuteChronicWorkloadRatio', acute.get('dailyAcuteChronicWorkloadRatio')),
     'primary':bool(blob.get('primaryTrainingDevice')),
    })
    break
 # Walk known and generic child containers, skip identifier-only maps by recursing values
 skip={'userId','deviceId','recordedDevices','showSelector'}
 for k,v in blob.items():
  if k in skip:continue
  if k in {'mostRecentTrainingStatus','latestTrainingStatusData','weeklyTrainingStatusList','weeklyTrainingLoadList','trainingStatusList','entries','items','metrics','mostRecentTrainingLoadBalance','data'} or isinstance(v,(dict,list)):
   _training_rows(v,out,depth+1)
 return out
def ingest_training_status(ranges, add, training):
 blobs=[]
 if not isinstance(ranges,dict):return
 for key in ('training_status','training_status_weekly','training_status_daily'):
  if ranges.get(key) is not None:blobs.append(ranges.get(key))
 rows=_training_rows(blobs)
 # de-dupe by date, last write wins (later files / more recent payloads)
 by={}
 for row in rows:
  d=row.get('date')
  if not d:continue
  prev=by.get(d)
  if prev and prev.get('primary') and not row.get('primary'):
   continue
  by[d]=row
 for d,row in sorted(by.items()):
  # already last-write; prefer primary device if both exist
  status=training_status_de(row.get('phrase'))
  if status:training[d]={'date':d,'status':status}
  note=('Trainingsstatus: '+status) if status else None
  add('load',d,row.get('load'),note)
  add('chronic',d,row.get('chronic'),note)
  add('acwr',d,row.get('acwr'),note)

def _num(v,scale=1,digits=1):
 import math
 return round(v*scale,digits) if isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and v>=0 else None
def activity_record(a):
 """Eine Garmin-Aktivität ohne IDs, Namen, Orte oder Koordinaten; fehlende Werte werden weggelassen."""
 local=a.get('startTimeLocal');key=(a.get('activityType') or {}).get('typeKey')
 r={'date':local[:10],'time':local[11:16],'sport':SPORTS.get(key,'Sonstige Aktivität'),'sportKey':key or 'other','durationMinutes':round((a.get('duration') or 0)/60,2),'distanceKm':round((a.get('distance') or 0)/1000,3),'pulse':a.get('averageHR')}
 cad=a.get('averageRunningCadenceInStepsPerMinute');bike=a.get('averageBikingCadenceInRevPerMinute')
 extra={'movingMinutes':_num(a.get('movingDuration'),1/60,2),'maxPulse':_num(a.get('maxHR'),1,0),'calories':_num(a.get('calories'),1,0),
  'avgSpeedKmh':_num(a.get('averageSpeed'),3.6,2) if a.get('distance') else None,'maxSpeedKmh':_num(a.get('maxSpeed'),3.6,2) if a.get('distance') else None,
  'elevationGain':_num(a.get('elevationGain'),1,0),'elevationLoss':_num(a.get('elevationLoss'),1,0),
  'aerobicTE':_num(a.get('aerobicTrainingEffect')),'anaerobicTE':_num(a.get('anaerobicTrainingEffect')),'trainingLoad':_num(a.get('activityTrainingLoad'),1,0),
  'cadence':_num(cad if cad else bike,1,0),'cadenceUnit':('Schritte/min' if cad else 'U/min' if bike else None),'maxCadence':_num(a.get('maxRunningCadenceInStepsPerMinute') if cad else a.get('maxBikingCadenceInRevPerMinute'),1,0),
  'avgPower':_num(a.get('avgPower'),1,0) or None,'maxPower':_num(a.get('maxPower'),1,0) or None,'normPower':_num(a.get('normPower'),1,0) or None,
  'steps':_num(a.get('steps'),1,0),'strokes':_num(a.get('strokes'),1,0),'strokeDistanceM':_num(a.get('avgStrokeDistance'),.01,2),'maxStrokeRate':_num(a.get('maxStrokeCadence'),1,0),
  'strideCm':_num(a.get('avgStrideLength'),1,0),'groundContactMs':_num(a.get('avgGroundContactTime'),1,0),'verticalOscillationCm':_num(a.get('avgVerticalOscillation'),1,1),'verticalRatio':_num(a.get('avgVerticalRatio'),1,1),
  'moderateMinutes':_num(a.get('moderateIntensityMinutes'),1,0),'vigorousMinutes':_num(a.get('vigorousIntensityMinutes'),1,0),
  'vo2max':_num(a.get('vO2MaxValue'),1,0),'sets':_num(a.get('totalSets'),1,0),'reps':_num(a.get('totalReps'),1,0),'laps':_num(a.get('lapCount'),1,0)}
 if isinstance(a.get('differenceBodyBattery'),(int,float)):extra['bodyBattery']=a['differenceBodyBattery']
 label=TE_LABELS.get(a.get('trainingEffectLabel'))
 if label:extra['teLabel']=label
 zones=[a.get(f'hrTimeInZone_{i}') for i in range(1,6)]
 if all(isinstance(z,(int,float)) for z in zones) and sum(zones)>0:extra['hrZonesMinutes']=[round(z/60,1) for z in zones]
 r.update({k:v for k,v in extra.items() if v is not None})
 return r
def extend(data):
 series={k:{} for k,*_ in EXTRA};activities={};training={}
 def add(k,d,v,note=None):
  if not isinstance(v,(int,float)) or v<0 or not d:return
  p={'date':d,'value':round(v,3),'source':'Garmin' if k not in {'visceral','pwv','vascular','nerve'} else 'Withings'}
  if note:p['note']=note
  series[k][d]=p
 for file in sorted(Path('/workspace/withings/data').glob('*.json')):
  raw=json.loads(file.read_text())
  for g in sorted(raw.get('measures_raw',{}).get('body',{}).get('measuregrps',[]),key=lambda g:g['date']):
   if g.get('attrib') in (1,4) or g.get('category',1)!=1:continue
   vals={m['type']:m['value']*10**m['unit'] for m in g.get('measures',[])}
   if 9 in vals or 10 in vals:continue
   day=datetime.fromtimestamp(g['date'],ZoneInfo('Europe/Berlin')).date().isoformat()
   for t,k in {170:'visceral',91:'pwv',155:'vascular',167:'nerve'}.items():add(k,day,vals.get(t))
 for file in sorted(Path('/workspace/garmin/data').glob('*.json')):
  raw=json.loads(file.read_text());ranges=raw.get('ranges') or {}
  for day,r in raw.get('daily',{}).items():
   s=r.get('stats') or {}
   for f,k in [('bodyBatteryHighestValue','bbhigh'),('bodyBatteryLowestValue','bblow'),('bodyBatteryChargedValue','bbcharged')]:add(k,day,s.get(f))
   r=r.get('respiration') or {}
   for f,k in [('avgWakingRespirationValue','respawake'),('avgSleepRespirationValue','respsleep')]:add(k,day,r.get(f))
  for h in (ranges.get('hrv_range') or {}).get('hrvSummaries',[]):
   base=h.get('baseline') or {};lo=base.get('balancedLow');hi=base.get('balancedUpper')
   note='Status: '+STATUS.get(h.get('status'),'Nicht eingeordnet')
   if lo is not None and hi is not None:note+=f' · Basisbereich: {lo}–{hi} ms'
   add('hrv',h.get('calendarDate'),h.get('lastNightAvg'),note)
  for b in ranges.get('body_battery') or []:
   day=b.get('date');vs=[a[1] for a in b.get('bodyBatteryValuesArray',[]) if isinstance(a[1],(int,float)) and a[1]>=0]
   for k,v in [('bbhigh',max(vs) if vs else None),('bblow',min(vs) if vs else None),('bbcharged',b.get('charged'))]:
    if day not in series[k]:add(k,day,v)
  maxrows=ranges.get('max_metrics_range') or []
  recent=(ranges.get('training_status') or {}).get('mostRecentVO2Max')
  if recent:maxrows=maxrows+[recent]
  for m in maxrows:
   for f,k in [('generic','vo2run'),('rowing','vo2row')]:
    v=m.get(f) or {};add(k,v.get('calendarDate'),v.get('vo2MaxPreciseValue',v.get('vo2MaxValue')),'Garmin allgemein; Sportzuordnung nicht separat bestätigt' if f=='generic' else None)
  ingest_training_status(ranges, add, training)
  for a in raw.get('activities') or []:
   key=a.get('activityId') or a.get('startTimeLocal');local=a.get('startTimeLocal')
   if not local:continue
   sport=SPORTS.get((a.get('activityType') or {}).get('typeKey'),'Sonstige Aktivität')
   activities[key]=activity_record(a)
 for k,n,u,c,t in EXTRA:
  data['metrics'].append({'id':k,'name':n,'unit':u,'category':c,'chart':t,'points':[dict(v,unit=u) for _,v in sorted(series[k].items())]})
 data['activities']=sorted(activities.values(),key=lambda a:(a['date'],a['time']),reverse=True)
 data['training']=sorted(training.values(),key=lambda a:a['date'],reverse=True)
 data['notes'].append('Trainingsstatus und Trainingslast kommen aus Garmin-Statusabfragen; fehlen neuere Tage, bleibt der letzte vorhandene Stand stehen und wird so gekennzeichnet. Nervengesundheit: Withings Typ 167; keine medizinische Interpretation.')
 from vo2_attribution import finalize_vo2_metrics
 return finalize_vo2_metrics(data)
