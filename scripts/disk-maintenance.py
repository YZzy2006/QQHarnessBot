#!/usr/bin/env python3
"""Bounded host maintenance: orphan DSH objects, journal retention and dedicated logrotate.
Never touches blog access logs, database/QQ volumes, sessions, memories or backups.
"""
import argparse,fcntl,hashlib,json,math,os,pathlib,re,stat,subprocess,time
ROOT=pathlib.Path('/opt/QQHarnessBot')
SCRATCH=re.compile(r'dsh-workspace-changes-[A-Za-z0-9]{6}')
FLAGS=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
class Unsafe(Exception):pass

def command(args,timeout=30):
 p=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 if p.returncode:raise RuntimeError('maintenance-command-failed:'+pathlib.Path(args[0]).name)
 return p.stdout

def disk():
 s=os.statvfs('/');used=(s.f_blocks-s.f_bfree)*s.f_frsize;available=s.f_bavail*s.f_frsize
 return dict(usedBytes=used,availableBytes=available,totalBytes=s.f_blocks*s.f_frsize,usedPercent=math.ceil(100*used/max(1,used+available)))

def process_start(pid):
 fields=(pathlib.Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()
 boot=next(int(s.split()[1]) for s in pathlib.Path('/proc/stat').read_text().splitlines() if s.startswith('btime '))
 return boot+int(fields[19])/os.sysconf('SC_CLK_TCK')

def dsh_start():
 pid=int(command(['/usr/bin/systemctl','show','dsh-web','--property=MainPID','--value']).strip())
 if pid<1:return None
 # Identity must be the currently running DSH executable, not an unrelated reused PID.
 cmd=(pathlib.Path('/proc')/str(pid)/'cmdline').read_bytes()
 if b'dsh' not in cmd:return None
 return process_start(pid)

def active_scratch(root,proc=pathlib.Path('/proc')):
 prefix=str(root)+'/' ;active=set()
 for p in proc.iterdir():
  if not p.name.isdigit():continue
  try:
   refs=[os.readlink(p/'cwd'),os.readlink(p/'root')]
   refs.extend(os.readlink(x) for x in (p/'fd').iterdir())
   for target in refs:
    if target.startswith(prefix):active.add(target[len(prefix):].split('/',1)[0])
   # A Git child can hold the object path in its environment without an open file yet.
   data=(p/'cmdline').read_bytes()+b'\0'+(p/'environ').read_bytes()
   active.update(x.decode() for x in re.findall(rb'dsh-workspace-changes-[A-Za-z0-9]{6}',data))
  except (FileNotFoundError,ProcessLookupError):continue
  # Permission failures fail closed: caller must not delete with an incomplete scan.
 return active

def fingerprint(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def snapshot(fd,uid,device,level=0):
 s=os.fstat(fd)
 if s.st_dev!=device or s.st_uid!=uid:raise Unsafe()
 entries={};latest=max(s.st_mtime,s.st_ctime);size=0
 for name in sorted(os.listdir(fd)):
  x=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if x.st_dev!=device or x.st_uid!=uid:raise Unsafe()
  latest=max(latest,x.st_mtime,x.st_ctime)
  if stat.S_ISDIR(x.st_mode):
   if not ((level==0 and name=='objects') or (level==1 and re.fullmatch('[a-f0-9]{2}',name))):raise Unsafe()
   child=os.open(name,FLAGS,dir_fd=fd)
   try:tree,age,n=snapshot(child,uid,device,level+1)
   finally:os.close(child)
   entries[name]=(fingerprint(x),tree);latest=max(latest,age);size+=n
  elif stat.S_ISREG(x.st_mode) and level==2 and re.fullmatch('[a-f0-9]{38}',name) and x.st_nlink==1:
   entries[name]=(fingerprint(x),None);size+=x.st_blocks*512
  else:raise Unsafe()
 return entries,latest,size

def remove_tree(fd,tree):
 for name,(expected,children) in tree.items():
  if fingerprint(os.stat(name,dir_fd=fd,follow_symlinks=False))!=expected:raise Unsafe()
  if children is None:os.unlink(name,dir_fd=fd)
  else:
   child=os.open(name,FLAGS,dir_fd=fd)
   try:
    if fingerprint(os.fstat(child))!=expected:raise Unsafe()
    remove_tree(child,children)
   finally:os.close(child)
   bound=os.stat(name,dir_fd=fd,follow_symlinks=False)
   if (bound.st_dev,bound.st_ino)!=expected[:2]:raise Unsafe()
   os.rmdir(name,dir_fd=fd)

def clean_scratch(root=pathlib.Path('/tmp'),*,now=None,dsh_started=None,active=None,apply=False,uid=0,expected_plan=None):
 root=pathlib.Path(root);now=time.time() if now is None else now
 if not root.is_absolute() or root.resolve()!=root or root.is_symlink():raise ValueError('scratch-root-not-canonical')
 result=dict(eligibleDirs=0,eligibleBytes=0,removedDirs=0,removedBytes=0,skipped=0,errors=[],plan=[])
 expected=None
 if expected_plan is not None:
  if not isinstance(expected_plan,list) or len(expected_plan)>500:raise ValueError('invalid-preview-plan')
  expected={}
  for row in expected_plan:
   if not isinstance(row,dict) or not SCRATCH.fullmatch(row.get('name','')) or not re.fullmatch('[a-f0-9]{64}',row.get('fingerprint','')) or row['name'] in expected:raise ValueError('invalid-preview-plan')
   expected[row['name']]=row['fingerprint']
 if dsh_started is None:result['skippedReason']='dsh-process-identity-unavailable';return result
 cutoff=min(now-48*3600,dsh_started-60)
 active=active_scratch(root) if active is None else active
 parent=os.open(root,FLAGS)
 try:
  for name in sorted(os.listdir(parent)):
   if not SCRATCH.fullmatch(name):continue
   if expected is not None and name not in expected:result['skipped']+=1;continue
   if name in active:result['skipped']+=1;continue
   fd=None
   try:
    bound=os.stat(name,dir_fd=parent,follow_symlinks=False)
    if not stat.S_ISDIR(bound.st_mode) or max(bound.st_mtime,bound.st_ctime)>cutoff:result['skipped']+=1;continue
    fd=os.open(name,FLAGS,dir_fd=parent)
    if fingerprint(os.fstat(fd))!=fingerprint(bound):raise Unsafe()
    tree,latest,size=snapshot(fd,uid,bound.st_dev)
    if latest>cutoff:result['skipped']+=1;continue
    digest=hashlib.sha256(json.dumps([name,fingerprint(bound),tree],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if expected is not None and expected[name]!=digest:result['errors'].append('preview-object-changed');continue
    result['plan'].append({'name':name,'fingerprint':digest})
    result['eligibleDirs']+=1;result['eligibleBytes']+=size
    if apply:
     current,latest,_=snapshot(fd,uid,bound.st_dev)
     if current!=tree or latest>cutoff:raise Unsafe()
     remove_tree(fd,tree)
     x=os.stat(name,dir_fd=parent,follow_symlinks=False)
     if (x.st_dev,x.st_ino)!=(bound.st_dev,bound.st_ino):raise Unsafe()
     os.rmdir(name,dir_fd=parent);result['removedDirs']+=1;result['removedBytes']+=size
   except Unsafe:result['skipped']+=1
   except FileNotFoundError:result['skipped']+=1
   except OSError:result['errors'].append('scratch-entry-cannot-verify')
   finally:
    if fd is not None:os.close(fd)
 finally:os.close(parent)
 return result

def maintenance(mode,expected_plan=None):
 before=disk();result=dict(mode=mode,at=int(time.time()*1000),before=before,after=before,thresholdPercent=85,errors=[])
 if mode=='status':
  report=ROOT/'state/disk-maintenance/latest.json'
  if report.is_file():
   try:result['lastRun']=json.loads(report.read_text())
   except (OSError,ValueError):result['lastRunError']=True
  return result
 if mode=='auto' and before['usedPercent']<85:result['skippedReason']='below-threshold';return result
 result['dryRun']=mode=='preview'
 try:started=dsh_start()
 except (OSError,ValueError,RuntimeError,StopIteration):started=None
 result['scratch']=clean_scratch(dsh_started=started,apply=mode!='preview',expected_plan=expected_plan)
 result['errors'].extend(result['scratch']['errors'])
 if mode!='preview':
  # Only system journal and the separately reviewed exact syslog list. No /www paths.
  for args in [
   ['/usr/bin/journalctl','--rotate','--vacuum-size=512M','--vacuum-time=7d'],
   ['/usr/sbin/logrotate','--state','/var/lib/logrotate/qq-safe-maintenance.status','/etc/qq-safe-maintenance.logrotate']]:
   try:command(args,timeout=45)
   except (OSError,RuntimeError,subprocess.TimeoutExpired):result['errors'].append('log-retention-failed:'+pathlib.Path(args[0]).name)
  result['after']=disk();result['freedBytes']=max(0,result['after']['availableBytes']-before['availableBytes'])
  state=ROOT/'state/disk-maintenance';state.mkdir(mode=0o700,exist_ok=True)
  if state.is_symlink() or state.resolve()!=state:raise ValueError('maintenance-state-not-canonical')
  tmp=state/'latest.next';fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'w') as f:json.dump(result,f,ensure_ascii=False,indent=2)
  os.replace(tmp,state/'latest.json')
 return result

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['status','preview','apply','auto','scheduled']);p.add_argument('--expected-plan');a=p.parse_args()
 if os.geteuid()!=0:raise RuntimeError('host-maintenance-requires-root')
 lock=os.open('/run/lock/qq-disk-maintenance.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 try:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:print(json.dumps({'busy':True,'errors':['cleanup-already-running']}));return 1
  expected=json.loads(a.expected_plan) if a.expected_plan is not None else None
  if a.expected_plan is not None and (a.mode!='apply' or len(a.expected_plan)>100000):raise ValueError('invalid-preview-plan')
  result=maintenance(a.mode,expected_plan=expected);print(json.dumps(result,ensure_ascii=False));return 1 if result['errors'] else 0
 finally:os.close(lock)
if __name__=='__main__':
 try:raise SystemExit(main())
 except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired):print(json.dumps({'errors':['maintenance-failed-no-unrestricted-cleanup']}));raise SystemExit(1)
