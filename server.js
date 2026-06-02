/**
 * 易经六爻 AI 占卜 · MVP 后端
 * ---------------------------------------------------------------
 * 职责：
 *   1. 提供网页（public 文件夹里的前端）
 *   2. 接收前端"提问 + 摇卦"的请求
 *   3. 在后端完成三铜钱起卦、查卦
 *   4. 用你的 Kimi 密钥调用大模型生成解读，再把结果返回前端
 *
 * ★ 安全要点：Kimi 密钥放在"环境变量"里（见下方说明），
 *   绝不写死在代码里，更不会出现在前端，别人看不到。
 *
 * 运行前准备：
 *   1. 安装依赖：  npm init -y && npm install express
 *   2. 设置密钥（任选其一）：
 *      - Mac/Linux 终端： export MOONSHOT_API_KEY=你的密钥
 *      - 或在项目里建一个 .env 文件（需配合 dotenv，Claude Code 会帮你弄）
 *   3. 启动：  node server.js
 *   4. 浏览器打开： http://localhost:3000
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // 提供前端页面

// ===== 读入 64 卦数据（启动时加载一次）=====
const hexagrams = JSON.parse(fs.readFileSync(path.join(__dirname, "hexagrams.json"), "utf-8"));
const lookup = JSON.parse(fs.readFileSync(path.join(__dirname, "hexagram_lookup.json"), "utf-8"));
// 把数组转成 { id: 卦对象 } 方便查
const byId = {};
hexagrams.forEach((h) => (byId[h.id] = h));

// ===================================================================
// 一、起卦核心：三铜钱六爻法
// ===================================================================
/**
 * 抛一次 = 三枚铜钱。约定：字面=2，背面=3（这是一种常见传统，可调换）。
 * 三枚之和 → 6/7/8/9：
 *   6 老阴(变爻,记0)  7 少阳(记1)  8 少阴(记0)  9 老阳(变爻,记1)
 * 返回：{ value: 6|7|8|9, bit: '0'|'1', changing: true|false }
 */
function tossOneYao() {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    sum += Math.random() < 0.5 ? 2 : 3; // 每枚铜钱：字面2 或 背面3
  }
  // sum 取值范围 6~9
  const isYang = sum === 7 || sum === 9; // 7少阳、9老阳 为阳爻
  const changing = sum === 6 || sum === 9; // 6老阴、9老阳 为变爻
  return { value: sum, bit: isYang ? "1" : "0", changing };
}

/**
 * 摇一整卦：抛 6 次，从下往上（初爻→上爻）。
 * 返回本卦、变卦（若有变爻）及每爻明细。
 */
function castHexagram() {
  const yaos = [];
  for (let i = 0; i < 6; i++) yaos.push(tossOneYao());
  return resolveHexagram(yaos);
}

/**
 * 根据已有的六爻明细查出本卦/变卦（不重新随机）。
 * 用于：前端亲手抛掷后，把摇好的结果交给后端查卦。
 * yaos: 自下而上的数组，每项需含 { value:6|7|8|9 }
 */
function resolveHexagram(yaos) {
  // 归一化：从 value 推出 bit 与 changing，容错前端只传 value 的情况
  const norm = yaos.map((y) => {
    const v = y.value;
    return {
      value: v,
      bit: v === 7 || v === 9 ? "1" : "0",
      changing: v === 6 || v === 9,
    };
  });

  const benBinary = norm.map((y) => y.bit).join("");
  const ben = byId[lookup[benBinary]];

  const hasChanging = norm.some((y) => y.changing);
  let bian = null;
  if (hasChanging) {
    const bianBinary = norm
      .map((y) => (y.changing ? (y.bit === "1" ? "0" : "1") : y.bit))
      .join("");
    bian = byId[lookup[bianBinary]];
  }
  return { yaos: norm, ben, bian };
}

// ===================================================================
// 二、组装给 Kimi 的解卦提示词
// ===================================================================
function buildPrompt(question, ben) {
  // MVP 阶段只用本卦。变卦等迭代再加。
  return `你是一位精通《易经》的解卦明师，阅历深厚、洞察人心。说话稳重、有分量，三言两语便能点到要害，不啰嗦、不奉承，像一位可信赖的长者在为人指点迷津。

【用户的问题】
${question}

【摇得卦象】
卦名：${ben.fullName}（${ben.name}卦）— ${ben.trait}
象曰（古谶）：${ben.xiang}
卦义：${ben.meaning}
传统断语参考（事业）：${ben.aspects.career}
传统断语参考（决策）：${ben.aspects.decision}

【解读要求】
1. 开篇先把"象曰古谶/卦义"与用户的具体问题搭一座桥——用一句话点明这古老的卦象，落在用户这件事上意味着什么，让用户感到"这卦正是为我而来"。
2. 然后紧扣问题给出有分量的指点：形势如何、宜守宜进、要留意什么，要具体落到用户的处境，不可泛泛而谈。
3. 收尾给一句凝练的箴言式提醒，要有余味、说完整。
4. 全篇分为 2 到 3 个自然段，段落之间空一行，便于阅读。
5. 以"指点参考"的口吻，沉稳笃定但不把话说死，给人留有余地。
6. 总字数控制在 250 字左右，宁精勿冗。
7. 直接输出纯文本，不要使用任何 Markdown 符号：不要用星号(*或**)做加粗，不要用井号(#)做标题，不要用三连横线(---)做分割线。需要分段时直接换行即可。`;
}

// ===================================================================
// 三、调用 Kimi（Moonshot）API
// ===================================================================
async function askKimi(prompt) {
  const apiKey = process.env.MOONSHOT_API_KEY; // ★ 从环境变量读密钥
  if (!apiKey) {
    throw new Error("没有检测到 MOONSHOT_API_KEY 环境变量，请先设置你的 Kimi 密钥。");
  }

  const resp = await fetch("https://api.moonshot.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "kimi-k2.6", // 最新模型（老的 kimi-k2 系列已计划下线）
      temperature: 0.6, // 此模型当前要求 temperature=0.6（Kimi 可能随版本调整此限制）
      max_tokens: 2000, // 关闭思考后正文用不到这么多，留足余量防截断
      // ★ 关键：kimi-k2.6 默认开启"思考模式"，会产出大段 reasoning_content。
      //    官方关闭方式：thinking.type = "disabled"。关掉后正文直接回到 content。
      thinking: { type: "disabled" },
      messages: [
        {
          role: "system",
          content:
            "你是 Kimi，由 Moonshot AI 提供的人工智能助手。此处你扮演一位精通《易经》的解卦明师，回答安全、得体、稳重有分量。直接输出解读正文，不要输出任何分析过程或草稿。",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Kimi 接口返回错误 ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  // 只取正文 content。绝不回退到 reasoning_content（那是思考草稿，不应展示给用户）。
  let content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    return "解读生成失败，请再摇一次。";
  }
  // 保险：清理偶尔残留的 Markdown 符号（加粗星号、标题井号、分割线），保证纯文本展示。
  content = content
    .replace(/^\s*[-*_]{3,}\s*$/gm, "") // 整行的分割线 --- *** ___
    .replace(/\*\*(.+?)\*\*/g, "$1") // **加粗**
    .replace(/(^|\s)\*(?!\s)(.+?)(?<!\s)\*/g, "$1$2") // *斜体*
    .replace(/^#{1,6}\s+/gm, "") // # 标题
    .replace(/\n{3,}/g, "\n\n") // 多余空行压成一个
    .trim();
  return content;
}

// ===================================================================
// 四、对外接口：前端点"摇卦"时调用这里
// ===================================================================
app.post("/api/divine", async (req, res) => {
  try {
    const question = (req.body.question || "").trim();
    if (!question) {
      return res.status(400).json({ error: "请先输入你想问的问题。" });
    }

    // 1) 起卦：优先使用前端亲手抛掷的结果；若没传，则后端自行摇卦（兼容）
    let cast;
    const clientYaos = req.body.yaos;
    if (Array.isArray(clientYaos) && clientYaos.length === 6) {
      // 校验每爻 value 合法（6/7/8/9）
      const valid = clientYaos.every(
        (y) => y && [6, 7, 8, 9].includes(y.value)
      );
      if (!valid) {
        return res.status(400).json({ error: "六爻数据不合法。" });
      }
      cast = resolveHexagram(clientYaos);
    } else {
      cast = castHexagram();
    }
    const { yaos, ben, bian } = cast;
    if (!ben) {
      return res.status(500).json({ error: "未能识别卦象，请重新摇卦。" });
    }

    // 2) 调 Kimi 解读
    const prompt = buildPrompt(question, ben);
    const interpretation = await askKimi(prompt);

    // 3) 返回前端：卦象信息 + AI 解读
    res.json({
      question,
      hexagram: {
        name: ben.name,
        fullName: ben.fullName,
        trait: ben.trait,
        level: ben.level,
        upperSymbol: ben.upperSymbol,
        lowerSymbol: ben.lowerSymbol,
        xiang: ben.xiang,
        meaning: ben.meaning,
      },
      changingTo: bian ? bian.fullName : null, // 变卦（前端 MVP 可暂不展示）
      yaos: yaos.map((y) => ({ value: y.value, changing: y.changing })),
      interpretation,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "服务器出错了，请稍后再试。" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`六爻占卜 MVP 已启动： http://localhost:${PORT}`);
});
