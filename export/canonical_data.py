"""Stabiler Hash ausschließlich der in der App verwendeten Daten, ohne Laufzeit/Quellpfade."""
import hashlib,json,math
WITHINGS={'weight','fat','muscle','water','bone','pulse','visceral','pwv','vascular','nerve'}
def clean(x):
 if isinstance(x,dict):return {k:clean(v) for k,v in sorted(x.items()) if k not in {'built','generated_at','fetched_at'}}
 if isinstance(x,list):return [clean(v) for v in x]
 if isinstance(x,float):
  if not math.isfinite(x):raise ValueError('Ungültige Zahl')
  return int(x) if x.is_integer() else x
 return x
def canonical(data):
 metrics=[]
 for metric in sorted(data['metrics'],key=lambda m:m['id']):
  m=clean(metric);m['points']=sorted(m['points'],key=lambda p:p['date']);metrics.append(m)
 result={'metrics':metrics,'activities':sorted(clean(data.get('activities',[])),key=lambda a:json.dumps(a,sort_keys=True,ensure_ascii=False)),'training':sorted(clean(data.get('training',[])),key=lambda a:json.dumps(a,sort_keys=True,ensure_ascii=False))}
 if 'sleepSchedule' in data:result['sleepSchedule']=sorted(clean(data['sleepSchedule']),key=lambda x:x['date'])
 return result
def digest(data):return hashlib.sha256(json.dumps(canonical(data),sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()
def source_dates(data):
 dates={'garmin':set(),'withings':set()}
 for m in data['metrics']:
  for p in m['points']:
   source='withings' if p.get('source')=='Withings' or (p.get('source')=='Gesundheit-Verlauf' and m['id'] in WITHINGS) else 'garmin'
   dates[source].add(p['date'])
 for a in data.get('activities',[]):dates['garmin'].add(a['date'])
 for a in data.get('sleepSchedule',[]):dates['garmin'].add(a['date'])
 return {s:sorted(ds) for s,ds in dates.items()}
def metadata(data):
 dates=source_dates(data)
 return {'normalization':'health-data-v1','data_hash':digest(data),'source_dates':dates,'latest':{s:max(ds) if ds else None for s,ds in dates.items()},'date_counts':{s:len(ds) for s,ds in dates.items()}}
