function renderReportHtml(report) {
  const model = normalizeReport(report);
  const rows = [
    ["公司名稱", model.company],
    ["工廠編號", model.factoryNumber],
    ["工廠實際地址", model.address],
    ["土地資料", model.landData],
    ["工廠登記狀態", model.registrationStatus],
    ["備註", model.notes]
  ];
  const quoteBlock = model.quote
    ? `<table><tr><th>用地變更服務報價</th><td>新台幣 ${escapeHtml(model.quote)} 元</td></tr></table>`
    : `<table><tr><th>用地變更服務報價</th><td>視案件規模與難易度現場評估</td></tr></table>`;

  return `
<div class="header">
  <h1>【善水工商地產】工商地產開發評估與建議報告</h1>
  <h2>專案顧問：陳俊憲 經理 ｜ 聯絡電話：0927-338-599</h2>
  <p style="text-align: right; margin-top: 10px; font-size: 14px;">評估日期：${escapeHtml(model.reportDate)}</p>
</div>
<div class="section-title">一、公司與工廠基本資料整理</div>
<table>${rows.map(([label, value]) => `<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</table>
<div class="section-title">二、土地與地籍圖資分析</div>
<ul>${model.landAnalysis.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
<div class="section-title">三、土地使用與法規重點說明</div>
<ul>${model.regulatoryNotes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
<div class="section-title">四、變更前後價值比較與增值試算</div>
<ul>${model.valueComparison.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
<div class="section-title">五、說明提出用地變更最後的送件時間</div>
<p>${escapeHtml(model.deadlineSection)}</p>
<div class="section-title">六、現在申請與3年後申請之成本與風險差異分析</div>
<table>
  <tr><th>比較項目</th><th>方案A：現在辦理</th><th>方案B：三年後辦理</th></tr>
  ${model.costRiskComparison.map((row) => `<tr><td>${escapeHtml(row.item)}</td><td>${escapeHtml(row.now)}</td><td>${escapeHtml(row.later)}</td></tr>`).join("")}
</table>
${quoteBlock}
<div class="section-title">七、開發可行性評估與潛在風險說明</div>
<ul>${model.risks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
<div class="section-title">八、建議開發方向、執行步驟與客戶參考重點</div>
<ol>${model.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`.trim();
}

function normalizeReport(report) {
  const now = new Date();
  const dateLabel = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  return {
    company: text(report.company, "待查證"),
    factoryNumber: text(report.factoryNumber, "待查證"),
    address: text(report.address, "待查證"),
    landData: text(report.landData, "待查證"),
    registrationStatus: text(report.registrationStatus, "待查證"),
    notes: text(report.notes, "需補充資料"),
    reportDate: text(report.reportDate, dateLabel),
    quote: text(report.quote, ""),
    landAnalysis: list(report.landAnalysis, ["地段地號、鄰地使用、臨路條件與套繪成果待查證。"]),
    regulatoryNotes: list(report.regulatoryNotes, ["需依官方資料確認都內或都外適用法規，未確認前一律標示待查證。"]),
    valueComparison: list(report.valueComparison, ["增值試算需建立在假設條件下，不保證實際價格表現。"]),
    deadlineSection: text(report.deadlineSection, "請務必於民國121年3月19日前完成申請規劃與送件，逾期風險與政策變動需另行評估。"),
    costRiskComparison: Array.isArray(report.costRiskComparison) && report.costRiskComparison.length ? report.costRiskComparison : [
      { item: "政策不確定性", now: "較低，應儘速準備", later: "較高，可能增加限制" },
      { item: "資料整備成本", now: "可分階段規劃", later: "可能集中爆發" },
      { item: "資產規劃彈性", now: "較高", later: "可能受限" }
    ],
    risks: list(report.risks, ["法規適用、土地文件、基礎設施與鄰地協調均需逐項查證。"]),
    recommendations: list(report.recommendations, ["建議立即盤點文件、確認工廠實際地址、及早啟動合法化評估流程。"])
  };
}

function text(value, fallback) {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function list(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => String(item ?? "").trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

module.exports = { renderReportHtml };
