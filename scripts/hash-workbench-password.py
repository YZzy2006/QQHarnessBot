#!/usr/bin/env python3
from pathlib import Path
import getpass,json,subprocess
root=Path(__file__).resolve().parent.parent
password=getpass.getpass('新工作台密码（BCrypt，最多72字节）: ')
if not password or len(password.encode())>72:raise SystemExit('密码须为1–72字节')
if password!=getpass.getpass('再次输入: '):raise SystemExit('两次输入不一致')
code="import {createRequire} from 'node:module'; const require=createRequire(new URL('./.workbench-deps/package.json',import.meta.url)); const bcrypt=require('bcryptjs'); let s=''; for await(const c of process.stdin)s+=c; console.log(await bcrypt.hash(JSON.parse(s).password,12));"
p=subprocess.run(['node','--input-type=module','-e',code],cwd=root,input=json.dumps({'password':password}),text=True)
raise SystemExit(p.returncode)
