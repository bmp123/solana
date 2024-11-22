import cv2
import numpy as np
import sys
import requests
import json
from io import BytesIO

def check_for_lock(image_url, template_path):
    try:
        # Загружаем основное изображение из URL
        response = requests.get(image_url)
        if response.status_code != 200:
            raise Exception(f"Ошибка загрузки изображения: {response.status_code}")

        # Преобразуем загруженное изображение в формат OpenCV
        main_image = np.array(cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_GRAYSCALE))

        # Загружаем локальный шаблон
        template_image = cv2.imread(template_path, cv2.IMREAD_GRAYSCALE)
        if template_image is None:
            raise Exception(f"Шаблон не найден: {template_path}")

        # Получаем размеры шаблона
        template_height, template_width = template_image.shape

        # Выполняем шаблонное совпадение
        result = cv2.matchTemplate(main_image, template_image, cv2.TM_CCOEFF_NORMED)

        # Находим максимальное значение совпадения
        _, max_val, _, max_loc = cv2.minMaxLoc(result)

        # Определяем порог совпадения
        threshold = 0.8
        if max_val >= threshold:
            return {
                "found": True,
                "location": max_loc,
                "confidence": max_val
            }
        else:
            return {
                "found": False,
                "confidence": max_val
            }
    except Exception as e:
        return {
            "error": str(e)
        }

if __name__ == "__main__":
    try:
        # Проверяем аргументы командной строки
        if len(sys.argv) != 3:
            print(json.dumps({"error": "Использование: python check_lock.py <image_url> <template_path>"}))
            sys.exit(1)

        # Считываем аргументы
        image_url = sys.argv[1]
        template_path = sys.argv[2]

        # Проверяем наличие замка
        result = check_for_lock(image_url, template_path)
        print(json.dumps(result))  # Возвращаем результат в формате JSON
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
