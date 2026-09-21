// 临时脚本：检查 SAM ONNX 模型的输入/输出名称、数据类型和形状
const path = require('path');
(async () => {
  let ort;
  try {
    ort = require('onnxruntime-node');
  } catch (e) {
    try { ort = require('onnxruntime-web/node'); } catch (e2) {
      console.log('NO_ORT', e.message, e2.message);
      process.exit(0);
    }
  }
  const dir = 'E:\\Doubao download';
  const files = ['sam_vit_b_01ec64.encoder-fp16.onnx', 'sam_vit_b_01ec64.decoder.onnx'];
  for (const f of files) {
    try {
      const p = path.join(dir, f);
      const s = await ort.InferenceSession.create(p);
      console.log('=====', f);
      console.log('inputNames', s.inputNames);
      if (s.inputTypes) console.log('inputTypes', s.inputTypes);
      if (s.inputShapes) console.log('inputShapes', JSON.stringify(s.inputShapes));
      console.log('outputNames', s.outputNames);
      if (s.outputTypes) console.log('outputTypes', s.outputTypes);
      if (s.outputShapes) console.log('outputShapes', JSON.stringify(s.outputShapes));
      // 反射读取内部元数据
      try {
        const handler = s.handler || s._handler;
        if (handler && handler.sessionMetadata) console.log('metadata', JSON.stringify(handler.sessionMetadata));
      } catch {}
    } catch (e) {
      console.log('ERR', f, e.message);
    }
  }
})();
