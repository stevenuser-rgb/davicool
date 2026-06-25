function validateReportHtml(html, spec) {
  const normalized = String(html || "");
  const issues = [];
  const passed = [];

  if (normalized.includes("<html") || normalized.includes("<body")) issues.push("Output must be an HTML fragment, not a full document.");
  else passed.push("fragment-only");

  if (normalized.includes("善水工商地產") && normalized.includes("陳俊憲") && normalized.includes("0927-338-599")) passed.push("required-header-identity");
  else issues.push("Missing required consultant identity in header.");

  if (normalized.includes("民國121年3月19日前")) passed.push("deadline-present");
  else issues.push("Missing required deadline phrase.");

  if (normalized.includes("待查證") || normalized.includes("需補充資料")) passed.push("verification-markers-present");
  else issues.push("No verification marker found for uncertain facts.");

  for (const section of spec.sections) {
    if (normalized.includes(section.title)) passed.push(`section:${section.key}`);
    else issues.push(`Missing section: ${section.title}`);
  }

  const sectionTitleCount = (normalized.match(/class="section-title"/g) || []).length;
  if (sectionTitleCount >= spec.sections.length) passed.push("section-title-class-count");
  else issues.push("Not enough section-title blocks.");

  return { ok: issues.length === 0, issues, passed };
}

module.exports = { validateReportHtml };
