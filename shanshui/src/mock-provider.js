function generateMockReport(input) {
  const descriptor = input.company || input.factoryNumber || input.address || "待查證案件";
  return {
    provider: "mock",
    report: {
      company: input.company || descriptor,
      factoryNumber: input.factoryNumber || "待查證",
      address: input.address || "待查證",
      landData: "地段地號、使用分區、臨路條件待查證",
      registrationStatus: hasSpecificFactoryNumber(input.factoryNumber) ? "工廠編號以 S 開頭，視為已取得特定工廠登記；細部核准範圍待查證" : "工廠登記狀態待查證",
      notes: input.notes || "本版本為整合骨架示範，實際報告需串接正式圖資、法規與案件資料來源。",
      quote: input.quote || "",
      landAnalysis: [
        "需確認地段地號、都市計畫內外別、鄰地使用與臨路條件。",
        "若工廠實際地址與登記資料不一致，報告僅應以工廠實際地址為比對基準。",
        "尚未取得正式地籍與圖資前，所有套繪結論均標示待查證。"
      ],
      regulatoryNotes: [
        `目前案件 zoningMode 為 ${input.zoningMode || "待查證"}，實際適用法規需查核官方資料。`,
        "特定目的事業用地相關分析可討論建蔽率 70%、容積率 180%，但應明確標示適用條件。",
        "工廠管理輔導法與土地使用變更路徑需依都內或都外模式分流說明。"
      ],
      valueComparison: [
        "現況若為農地或未完整合法化使用，資產利用彈性較低。",
        "完成合法化後可能提升使用彈性與資產規劃能力，但不保證價格上漲。",
        "所有增值試算必須附上前提假設與風險說明。"
      ],
      deadlineSection: "申請規劃應以民國121年3月19日前完成送件準備為目標，延遲將增加政策與時程風險。",
      costRiskComparison: [
        { item: "政策不確定性", now: "較低，可提前布局", later: "較高，可能面臨規則變動" },
        { item: "文件整備壓力", now: "可分階段準備", later: "可能集中處理，成本偏高" },
        { item: "資金與營運規劃", now: "有時間整合", later: "彈性下降" }
      ],
      risks: [
        "法規適用錯誤風險：需確認實際分區與登記狀態。",
        "土地文件不完整風險：地籍、建物、使用現況與鄰地資料需補件。",
        "時程風險：若延至後期才啟動，可能壓縮合法化窗口。"
      ],
      recommendations: [
        "先確認工廠實際地址、工廠編號與土地基本資料。",
        "補齊地籍與工廠相關文件後，再進入正式法規評估與價值試算。",
        "若案件需對外展示，先經 validator 檢查八大章節結構再發布。"
      ]
    }
  };
}

function generateMockExtension(input) {
  const map = {
    summary: "1. 優先確認工廠實際地址與地籍資料。\n2. 依法規時程，應提早布局。\n3. 所有增值分析都必須標示假設前提。",
    pitch: "電話開場：先確認工廠實際位置與合法化時程壓力，再切入資產規劃價值。",
    objection: "常見疑慮：費用與時程。\n破解方式：先做文件盤點與風險分級，再談正式投入。",
    email: "主旨：善水工商地產案件初步評估建議\n內文：建議先安排短會確認工廠現況與送件節點。",
    followup: "Day 1 先確認資料完整性；Week 1 安排訪談；Week 2 完成風險清單。",
    market: "重點不是保證增值，而是提升合法化後的營運與資產規劃彈性。"
  };
  return { mode: input.mode, text: map[input.mode] || map.summary, provider: "mock" };
}

function generateMockChat(input) {
  return {
    text: input.reportHtml ? "目前建議先檢查八大章節是否完整，再補齊待查證資料。" : "尚未生成報告，請先提供公司名稱、工廠編號或工廠實際地址。",
    provider: "mock"
  };
}

function hasSpecificFactoryNumber(factoryNumber) {
  return String(factoryNumber || "").trim().toUpperCase().startsWith("S");
}

module.exports = { generateMockReport, generateMockExtension, generateMockChat };
