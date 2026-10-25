from login import *
import config


login_system = NXUJwglLogin()

username = config.username
password = config.password
API_KEY = config.API_KEY
SECRET_KEY = config.SECRET_KEY
# 输入用户名和密码
if not config.username:
    username = input("请输入用户名: ")
if not config.password:
    password = input("请输入密码: ")
if not config.API_KEY:
    print(
        "请前往百度智能云获取API Key并填入config.py（免费注册）网址：https://cloud.baidu.com/product/ocr_general"
    )
    exit(1)
count = 1
for url in config.urls:
    print(f"第{count}次登陆，url: {url}")
    login_system.base_url = url
    # 执行登录
    if login_system.login(username, password):
        print("登录成功!")
        # 验证登录状态
        if login_system.check_login_status():
            print("登录状态验证成功")
            break
        else:
            print("登录状态验证失败")
    else:
        print("登录失败")
        count += 1
