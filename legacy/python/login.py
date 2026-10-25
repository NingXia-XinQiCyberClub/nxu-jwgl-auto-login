import requests
# import cv2
import numpy as np
from PIL import Image

# import pytesseract
# import re
import time
from io import BytesIO
import requests
import base64

# import json
import config


class NXUJwglLogin:
    def __init__(self):
        self.session = requests.Session()
        self.base_url = "https://jwgl.nxu.edu.cn"
        self.session.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
            }
        )

    def get_captcha_image(self):
        """获取验证码图片"""
        captcha_url = f"{self.base_url}/captcha/image.action"
        timestamp = int(time.time() * 1000)
        url = f"{captcha_url}?t={timestamp}"

        try:
            response = self.session.get(url)
            if response.status_code == 200:
                return response.content
            else:
                print(f"获取验证码失败，状态码: {response.status_code}")
                return None
        except Exception as e:
            print(f"获取验证码时发生错误: {e}")
            return None

    # def preprocess_captcha(self, image_data):
    #     """预处理验证码图片以提高识别准确率"""
    #     try:
    #         # 将图片数据转换为OpenCV格式
    #         image = Image.open(BytesIO(image_data))
    #         img = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)

    #         # 转换为灰度图
    #         gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    #         # 二值化处理
    #         _, thresh = cv2.threshold(
    #             gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    #         )

    #         # 降噪处理
    #         kernel = np.ones((2, 2), np.uint8)
    #         processed = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)

    #         return processed
    #     except Exception as e:
    #         print(f"验证码预处理失败: {e}")
    #         return None

    # def recognize_captcha(self, image_data):
    # 	 """识别验证码"""
    # 	 try:
    # 		 # 预处理图片
    # 		 processed_image = self.preprocess_captcha(image_data)
    # 		 if processed_image is None:
    # 			 return None

    # 		 # 使用pytesseract识别验证码
    # 		 custom_config = r"--oem 3 --psm 8 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

    # 		 # 第一次识别
    # 		 result1 = pytesseract.image_to_string(processed_image, config=custom_config)
    # 		 result1 = re.sub(r"[^a-zA-Z0-9]", "", result1)

    # 		 # 使用不同的配置进行第二次识别
    # 		 custom_config2 = r"--oem 3 --psm 7"
    # 		 result2 = pytesseract.image_to_string(
    # 			 processed_image, config=custom_config2
    # 		 )
    # 		 result2 = re.sub(r"[^a-zA-Z0-9]", "", result2)

    # 		 # 选择长度更合理的结果
    # 		 final_result = result1 if len(result1) >= 4 else result2

    # 		 # 清理结果，只保留字母和数字
    # 		 final_result = re.sub(r"[^a-zA-Z0-9]", "", final_result)

    # 		 print(
    # 			 f"识别结果 - 第一次: {result1}, 第二次: {result2}, 最终: {final_result}"
    # 		 )

    # 		 return final_result if final_result else None

    # 	 except Exception as e:
    # 		 print(f"验证码识别失败: {e}")
    # 		 return None

    def recognize_captcha_baidu(self, image_data):
        """使用百度OCR识别验证码"""
        # 获取百度OCR API密钥（免费注册）
        # 访问：https://cloud.baidu.com/product/ocr_general
        API_KEY = config.API_KEY
        SECRET_KEY = config.SECRET_KEY

        # 获取access_token
        auth_url = f"https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id={API_KEY}&client_secret={SECRET_KEY}"
        auth_response = requests.get(auth_url)
        access_token = auth_response.json().get("access_token")

        # 调用OCR接口
        ocr_url = "https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic"
        headers = {"content-type": "application/x-www-form-urlencoded"}
        data = {
            "image": base64.b64encode(image_data).decode(),
            "access_token": access_token,
        }

        response = requests.post(ocr_url, data=data, headers=headers)
        result = response.json()

        if "words_result" in result:
            words = result["words_result"]
            if words:
                captcha_text = words[0]["words"].strip()
                # 清理结果，只保留字母和数字
                import re

                captcha_text = re.sub(r"[^a-zA-Z0-9]", "", captcha_text)
                return captcha_text
        return None

    def manual_captcha_input(self, image_data):
        """手动输入验证码的备选方案"""
        try:
            # 显示验证码图片
            image = Image.open(BytesIO(image_data))
            image.show()
            captcha = input("请查看弹出的验证码图片并输入验证码: ")
            return captcha.strip()
        except Exception as e:
            print(f"手动输入验证码失败: {e}")
            return None

    def login(self, username, password, max_retry=5):
        """执行登录操作"""
        # 首先访问首页获取JSESSIONID
        try:
            response = self.session.get(f"{self.base_url}/index.action")
            if response.status_code != 200:
                print("访问首页失败")
                return False
        except Exception as e:
            print(f"访问首页时发生错误: {e}")
            return False

        for attempt in range(max_retry):
            print(f"登录尝试第 {attempt + 1} 次...")

            # 获取验证码
            captcha_image = self.get_captcha_image()
            if not captcha_image:
                print("无法获取验证码")
                continue

            # 识别验证码
            captcha_code = self.recognize_captcha_baidu(captcha_image)

            # 如果自动识别失败，使用手动输入
            if not captcha_code or len(captcha_code) < 4:
                print("自动识别验证码失败，切换到手动输入")
                captcha_code = self.manual_captcha_input(captcha_image)
                if not captcha_code:
                    continue

            # 准备登录数据
            login_data = {
                "request_locale": "zh_CN",
                "loginForm.name": username,
                "loginForm.password": password,
                "loginForm.captcha": captcha_code,
            }

            # 执行登录
            try:
                login_url = f"{self.base_url}/login.action"
                response = self.session.post(login_url, data=login_data)

                # 检查登录是否成功
                if (
                    "loginForm.name" not in response.text
                    and "验证码" not in response.text
                ):
                    print("登录成功!")
                    return True
                else:
                    print("登录失败，验证码可能错误")
                    # 保存错误的验证码用于调试
                    with open(f"failed_captcha_{attempt}.png", "wb") as f:
                        f.write(captcha_image)

            except Exception as e:
                print(f"登录请求失败: {e}")

        print("超过最大重试次数，登录失败")
        return False

    def check_login_status(self):
        try:
            response = self.session.get(f"{self.base_url}/index.action")
            status = "loginForm.name" not in response.text
            if status:
                print("当前有效Cookie:", self.session.cookies.get_dict())
            return status
        except Exception as e:
            print(f"检查登录状态失败: {e}")
            return False


def main():
    # 初始化登录器
    login_system = NXUJwglLogin()

    # 输入用户名和密码
    username = input("请输入用户名: ")
    password = input("请输入密码: ")

    # 执行登录
    if login_system.login(username, password):
        print("登录成功!")

        # 验证登录状态
        if login_system.check_login_status():
            print("登录状态验证成功")
        else:
            print("登录状态验证失败")
    else:
        print("登录失败")


if __name__ == "__main__":
    main()
