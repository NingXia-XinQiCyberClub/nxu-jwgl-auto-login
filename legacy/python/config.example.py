"""本地配置模板：复制为 config.py 后填写。

    copy config.example.py config.py      # Windows
    cp config.example.py config.py        # Linux / macOS

config.py 已在 .gitignore 中，不会被提交。
"""

# 教务系统登录入口（不带末尾斜杠）
urls = [
    "https://jwgl.nxu.edu.cn",
]

# 百度智能云通用文字识别（OCR）的 AK / SK
# 留空则不做自动识别，运行时会弹图让你手动输入验证码
API_KEY = ""
SECRET_KEY = ""

# 仅填写本人账号
username = ""
password = ""
