#!/usr/bin/env python3
"""Initialize a local workbench account; never put the password in argv or logs."""
from pathlib import Path
import getpass,json,subprocess
root=Path(__file__).resolve().parent.parent
username=input('工作台用户名（3–40位字母数字_-）: ').strip()
password=getpass.getpass('工作台密码（至少12位）: ')
if password!=getpass.getpass('再次输入密码: '):raise SystemExit('两次密码不一致，未修改账号')
p=subprocess.run(['node',str(root/'scripts/workbench-account.mjs')],cwd=root,
 input=json.dumps({'stateDir':str(root/'state'),'username':username,'password':password}),text=True)
raise SystemExit(p.returncode)
