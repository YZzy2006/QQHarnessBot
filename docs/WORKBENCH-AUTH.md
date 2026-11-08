# 🔐 工作台账号：本地默认，MySQL可选

最小部署使用 `scripts/init-workbench-account.py` 创建本机独立账号，密码经stdin传递，保存scrypt盐和哈希。账号文件在 `state/workbench-auth.json`，不随仓库发布。

## 可选兼容 MySQL 身份库

公开版适配器只接受回环地址，通过受保护配置选择自己的独立数据库（建议 `qq_workbench`），查询兼容表 `admin_user`。需要字段：`id`、`username`、`password_hash`、`enabled`、`bot_workbench_enabled`、`lock_until`。其中密码使用BCrypt，账号启用且工作台开关为1、未锁定才可登录。应用执行带参数的SELECT；账户创建、改密和授权由数据库管理员在本机显式完成。

不要对已有博客直接执行建表/重置/全表授权。可先在独立测试库评估兼容性；数据库名必须通过严格标识符校验，表结构仍需满足下述兼容字段；不能连接任意远程数据库。

1. 在机器人目录安装独立依赖：

```bash
npm install --prefix .workbench-deps --save-exact mysql2@3.24.6 bcryptjs@3.0.3
```

2. 自建受保护JSON配置，例如 `/etc/qq-workbench-db.json`，只允许机器人运行用户读取：

```json
{
  "host": "127.0.0.1",
  "port": 3306,
  "database": "qq_workbench",
  "user": "your-readonly-account",
  "password": "your-database-password"
}
```

3. 在机器人服务环境配置 `QQ_WORKBENCH_DB_FILE` 指向该文件；不要把该变量仅设置给BotWork网关。
4. 按你的数据库管理流程初始化专用账号，最小化权限。不提供维护者数据库、账号或密码。配置了数据库认证后，数据库故障返回不可用，不回退本地账号绕过限制。

修改密码、启用状态、工作台权限或锁定状态会使既有会话失效。账号开通仅代表工作台访问，不应额外获得博客管理权限。

## 头像 OSS 适配

`src/workbench-portrait.js`只读取`QQ_WORKBENCH_OSS_FILE`指定的独立OSS配置，不查询博客数据库，也不复制维护者的OSS桶名、密钥或加密参数。对象仅写入`botwork/portraits/`，浏览器通过同源鉴权接口读取，不接收OSS密钥。

这是可选的独立存储适配，不是工作台必需条件；没有完整配置时上传不可用。自定义其他存储请实现同一存储接口并通过图片格式/大小、授权、失败重试和读取测试，不把原图或加密密钥提交仓库。


## 公开版与维护者运行环境的隔离

公开版不会连接维护者的OSS、博客数据库或任何维护者账号。源码中的本地账号是默认方案；可选MySQL和OSS接口已改为部署者自己的受保护配置。线上私有集成没有被修改或迁移。本仓库没有包含任何真实数据库/OSS配置文件、桶名、加密密钥、账号、导出SQL或生产数据。

### 可选独立OSS配置格式

在本机私有目录创建JSON，并仅给机器人运行用户读取权限（Unix 600），再把`QQ_WORKBENCH_OSS_FILE`指向它：

```json
{
  "endpoint": "oss-cn-hangzhou.aliyuncs.com",
  "bucket": "your-private-bucket",
  "accessKeyId": "your-access-key-id",
  "accessKeySecret": "your-access-key-secret"
}
```

这些全部是占位示例。只授予你自己的`botwork/portraits/`前缀所需读写权限，桶保持私有。代码保留`createBlogPortraitStorage`这个旧导出名是为了接口兼容，不代表仍读取博客或其他应用的配置；纯AES-GCM兼容函数也不自动读取或携带任何密钥。


## 独立数据库初始化示例（可选，默认不需要）

只有你决定启用MySQL登录时才需要这部分。先以数据库管理员身份在**你自己的环境**创建独立库和表，不在已有博客库里建表，也不读取其他项目账号或配置：

```sql
CREATE DATABASE qq_workbench CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE qq_workbench.admin_user (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  bot_workbench_enabled TINYINT NOT NULL DEFAULT 0,
  lock_until DATETIME NULL
);
CREATE USER 'qq_workbench_reader'@'127.0.0.1' IDENTIFIED BY 'your-unique-database-password';
GRANT SELECT ON qq_workbench.admin_user TO 'qq_workbench_reader'@'127.0.0.1';
```

示例中的库名、账号与密码均为公开占位内容，改成你自己的；不能直接把占位密码用在线上。应用连接账号只有SELECT权限。用户初始化由管理员完成，必须使用BCrypt密码哈希，不能存明文或把SHA256当作BCrypt。

先在机器人目录安装上述可选依赖，然后安全读取密码生成哈希：

```bash
python3 scripts/hash-workbench-password.py
```

将输出的BCrypt哈希仅在本机数据库管理工具中用于账号初始化；不要把哈希、SQL操作记录或数据库导出提交Git：

```sql
INSERT INTO qq_workbench.admin_user
  (username, password_hash, enabled, bot_workbench_enabled)
VALUES ('your-workbench-user', '<在本机粘贴新生成的BCrypt哈希>', 1, 1);
```

然后把本机受保护数据库JSON的`database`、`user`、`password`指向此独立库和只读连接账号。设置`QQ_WORKBENCH_DB_FILE`并重启**机器人桥接**后再验证登录。此时本地scrypt账号不作为后备入口；如果数据库不可用，修复连接或在本机显式撤销该环境配置，不能绕过认证。
