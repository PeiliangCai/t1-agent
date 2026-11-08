---
license: apache-2.0
library_name: PaddleOCR
language:
- en
- zh
pipeline_tag: image-to-text
tags:
- OCR
- PaddlePaddle
- PaddleOCR
- wired_table_classification
---

# PP-LCNet_x1_0_table_cls

## Introduction

The Table Classification Module is a key component in computer vision systems, responsible for classifying input table images. The performance of this module directly affects the accuracy and efficiency of the entire table recognition process. The Table Classification Module typically receives table images as input and, using deep learning algorithms, classifies them into predefined categories based on the characteristics and content of the images, such as wired and wireless tables. The classification results from the Table Classification Module serve as output for use in table recognition pipelines. The key metrics are as follow:

<table>
<tr>
<th>Model</th>
<th>Top1 Acc(%)</th>
<th>GPU Inference Time (ms)<br/>[Regular Mode / High-Performance Mode]</th>
<th>CPU Inference Time (ms)<br/>[Regular Mode / High-Performance Mode]</th>
<th>Model Storage Size (M)</th>
</tr>
<tr>
<td>PP-LCNet_x1_0_table_cls</td>
<td>94.2</td>
<td>2.35 / 0.47</td>
<td>4.03 / 1.35</td>
<td>6.6M</td>
</tr>
</table>

## Model Usage

### Install Dependencies

```shell
pip install -U paddleocr
pip install -U onnxruntime-gpu
```

### CLI Usage

```shell
paddleocr table_classification -i ./demo.jpg --model_name PP-LCNet_x1_0_table_cls --engine onnxruntime
```

### Python API Usage

```python
from paddleocr import TableClassification

model = TableClassification(
    model_name="PP-LCNet_x1_0_table_cls",
    engine="onnxruntime",
)
output = model.predict("./demo.jpg", batch_size=1)
for res in output:
    res.print()
    res.save_to_json(save_path="./output/res.json")
```