> 你是否受够了每次抢课、看课表、查成绩时，教务系统都登陆不上，而你只能一遍又一遍无助地刷新、填写学号、填写密码、看系统转圈

而现在，我们迎来了最终解决方案

我在此隆重介绍`教务管理系统自动登录脚本`

声明：本系统为开源软件，**禁止用以盈利！！！**

## 环境配置

首先保证你安装了 python 并将其加入了环境变量，然后在命令行里**和 main.py 同目录下**运行以下代码以安装运行库：

```plain text
pip install -r requirements.txt
```

然后在 config.py 中完善以下信息

```
API_KEY = "*****" # 百度apikey
SECRET_KEY = "*****" # 百度secretkey
username = "*****" # 你的学号
password = "*****" # 你的密码
```

最后，确保你连接校园网，并在命令行中运行主程序：

```plain text
python main.py
```
