const fsp = require("fs/promises");
const path = require("path");

async function buildPromptBundle({ promptsRoot, specRoot }) {
  const [
    reportPrompt,
    chatPrompt,
    summaryPrompt,
    pitchPrompt,
    objectionPrompt,
    emailPrompt,
    followupPrompt,
    marketPrompt,
    reportSpecRaw
  ] = await Promise.all([
    readText(path.join(promptsRoot, "report.txt")),
    readText(path.join(promptsRoot, "chat.txt")),
    readText(path.join(promptsRoot, "summary.txt")),
    readText(path.join(promptsRoot, "pitch.txt")),
    readText(path.join(promptsRoot, "objection.txt")),
    readText(path.join(promptsRoot, "email.txt")),
    readText(path.join(promptsRoot, "followup.txt")),
    readText(path.join(promptsRoot, "market.txt")),
    readText(path.join(specRoot, "report-sections.json"))
  ]);
  return {
    reportPrompt,
    chatPrompt,
    extensionPrompts: {
      summary: summaryPrompt,
      pitch: pitchPrompt,
      objection: objectionPrompt,
      email: emailPrompt,
      followup: followupPrompt,
      market: marketPrompt
    },
    reportSpec: JSON.parse(reportSpecRaw)
  };
}

async function readText(filePath) {
  return (await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
}

module.exports = { buildPromptBundle };
