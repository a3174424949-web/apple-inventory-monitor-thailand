# 泰国 Apple 库存桥接扩展

这个 Manifest V3 扩展只匹配 `https://www.apple.com/th/*`，把泰国 Apple 商品页产生的取货响应转发给本机看板 `http://127.0.0.1:4318`。

使用：

1. 打开 `chrome://extensions/`，开启开发者模式。
2. 点击“加载已解压的扩展程序”，选择本文件夹。
3. 刷新 `https://www.apple.com/th/shop/buy-iphone/iphone-18-pro`。
4. 在看板中保存 Central World、Iconsiam 和要监控的配置。

扩展只读官网库存信息，不加购、不下单、不支付。
