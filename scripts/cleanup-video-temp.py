#!/usr/bin/env python3
"""Remove only expired, inactive QQ video-processing scratch directories."""
import argparse,json,os,pathlib,re,stat,time
ROOT=pathlib.Path(__file__).resolve().parent.parent/'state'/'media-tmp'
UUID=r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
LEASE=re.compile(r'^video-([1-9][0-9]*)-([0-9]+)-('+UUID+r')-[A-Za-z0-9]{6}$')
LEGACY=re.compile(r'^video-[A-Za-z0-9]{6}$')
KNOWN=re.compile(r'^(source\.media|frame-[0-7]\.jpg|cell-[0-7]\.rgb|storyboard\.(rgb|jpg)|audio\.wav)$')
OPEN_FLAGS=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
class UnsafeDirectory(Exception):pass

def process_start_ticks(proc_root,pid):
 text=(pathlib.Path(proc_root)/str(pid)/'stat').read_text()
 fields=text.rsplit(')',1)[1].split()
 value=fields[19]
 if not value.isdigit():raise ValueError('Invalid process start time')
 return value

def owner_active(name,proc_root,boot_id):
 match=LEASE.fullmatch(name)
 if not match:return False
 pid,ticks,boot=match.groups()
 if boot!=boot_id:return False
 try:return process_start_ticks(proc_root,pid)==ticks
 except FileNotFoundError:return False

def open_video_dirs(root,proc_root):
 prefix=str(root)+'/'
 active=set()
 for pid in os.listdir(proc_root):
  if not pid.isdigit():continue
  directory=pathlib.Path(proc_root)/pid/'fd'
  try:descriptors=os.listdir(directory)
  except (FileNotFoundError,ProcessLookupError):continue
  for descriptor in descriptors:
   fd=directory/descriptor
   try:
    if not stat.S_ISREG(os.stat(fd).st_mode):continue
    target=os.readlink(fd)
   except (FileNotFoundError,ProcessLookupError):continue
   if target.endswith(' (deleted)'):target=target[:-10]
   if target.startswith(prefix):active.add(target[len(prefix):].split('/',1)[0])
 return active

def snapshot(fd):
 directory=os.fstat(fd);files={}
 for name in os.listdir(fd):
  entry=os.stat(name,dir_fd=fd,follow_symlinks=False)
  if not KNOWN.fullmatch(name) or not stat.S_ISREG(entry.st_mode) or entry.st_nlink!=1 or entry.st_dev!=directory.st_dev:raise UnsafeDirectory()
  files[name]=(entry.st_dev,entry.st_ino,entry.st_size,entry.st_mtime_ns,entry.st_ctime_ns)
 latest=max([directory.st_mtime,directory.st_ctime]+[max(v[3],v[4])/1e9 for v in files.values()])
 return directory,files,latest

def clean(root=ROOT,*,now=None,retention_seconds=21600,apply=False,proc_root=pathlib.Path('/proc'),boot_id=None):
 root=pathlib.Path(root);now=time.time() if now is None else now
 result=dict(scannedDirs=0,eligibleDirs=0,removedDirs=0,removedFiles=0,removedBytes=0,skippedYoung=0,skippedActive=0,skippedUnknown=0,errors=[],dryRun=not apply)
 if root.is_symlink() or not root.is_absolute() or root.resolve()!=root:raise ValueError('Media root must be a real absolute directory without symlinks')
 if not root.exists():result['rootAbsent']=True;return result
 root_fd=os.open(root,OPEN_FLAGS)
 try:
  if boot_id is None:boot_id=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
  if not re.fullmatch(UUID,boot_id):raise ValueError('Cannot verify current boot identity')
  candidates=[]
  for name in sorted(os.listdir(root_fd)):
   if not (LEASE.fullmatch(name) or LEGACY.fullmatch(name)):continue
   result['scannedDirs']+=1
   try:
    fd=os.open(name,OPEN_FLAGS,dir_fd=root_fd)
    try:directory,files,latest=snapshot(fd)
    finally:os.close(fd)
    if latest>now-retention_seconds:result['skippedYoung']+=1;continue
    if owner_active(name,proc_root,boot_id):result['skippedActive']+=1;continue
    candidates.append((name,directory.st_dev,directory.st_ino,files))
   except (UnsafeDirectory,NotADirectoryError):result['skippedUnknown']+=1
   except OSError as error:
    if isinstance(error,FileNotFoundError):continue
    result['skippedUnknown']+=1;result['errors'].append('cannot-verify-directory')
   except (ValueError,IndexError):result['errors'].append('cannot-verify-owner')
  if not candidates:return result
  try:active=open_video_dirs(root,proc_root)
  except OSError:result['errors'].append('cannot-check-open-files');return result
  for name,device,inode,files in candidates:
   if name in active:result['skippedActive']+=1;continue
   try:
    fd=os.open(name,OPEN_FLAGS,dir_fd=root_fd)
    try:
     current,current_files,latest=snapshot(fd)
     bound=os.stat(name,dir_fd=root_fd,follow_symlinks=False)
     if (current.st_dev,current.st_ino)!=(device,inode) or bound.st_ino!=inode or current_files!=files or latest>now-retention_seconds:raise UnsafeDirectory()
     if owner_active(name,proc_root,boot_id):result['skippedActive']+=1;continue
     result['eligibleDirs']+=1
     if not apply:continue
     for filename in files:os.unlink(filename,dir_fd=fd)
     bound=os.stat(name,dir_fd=root_fd,follow_symlinks=False)
     if bound.st_ino!=inode:raise UnsafeDirectory()
     os.rmdir(name,dir_fd=root_fd)
     result['removedDirs']+=1;result['removedFiles']+=len(files);result['removedBytes']+=sum(v[2] for v in files.values())
    finally:os.close(fd)
   except (UnsafeDirectory,OSError):result['errors'].append('directory-changed-or-cleanup-failed')
  return result
 finally:os.close(root_fd)

def main():
 parser=argparse.ArgumentParser(description=__doc__);group=parser.add_mutually_exclusive_group();group.add_argument('--apply',action='store_true');group.add_argument('--dry-run',action='store_true');args=parser.parse_args()
 try:result=clean(apply=args.apply)
 except (OSError,ValueError):print(json.dumps({'errors':['media-root-or-process-identity-unavailable'],'removedDirs':0}));return 1
 print(json.dumps(result));return 1 if result['errors'] else 0
if __name__=='__main__':raise SystemExit(main())
