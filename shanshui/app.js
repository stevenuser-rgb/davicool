const state = { reportHtml: "", providerMode: "loading" };
const form = document.getElementById("reportForm");
const preview = document.getElementById("reportPreview");
const validationOutput = document.getElementById("validationOutput");
const extensionOutput = document.getElementById("extensionOutput");
const providerMode = document.getElementById("providerMode");
const validationState = document.getElementById("validationState");

boot();

async function boot() {
  try {
    const response = await fetch("/api/shanshui/health");
    if (response.status === 401) {
      window.location.href = "/";
      return;
    }
    const payload = await response.json();
    state.providerMode = payload.providerMode;
    providerMode.textContent = payload.providerMode;
  } catch (error) {
    providerMode.textContent = "error";
    validationOutput.textContent = String(error.message || error);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  validationState.textContent = "running";
  const response = await fetch("/api/shanshui/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status === 401) {
    window.location.href = "/";
    return;
  }
  const payload = await response.json();
  state.reportHtml = payload.html;
  preview.innerHTML = payload.html;
  showValidation(payload.validation);
});

document.getElementById("validateButton").addEventListener("click", async () => {
  if (!state.reportHtml) {
    validationOutput.textContent = "尚未生成報告。";
    return;
  }
  const response = await fetch("/api/shanshui/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html: state.reportHtml })
  });
  const payload = await response.json();
  showValidation(payload);
});

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!state.reportHtml) {
      extensionOutput.textContent = "請先生成報告。";
      return;
    }
    extensionOutput.textContent = "載入中...";
    const response = await fetch("/api/shanshui/extension", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: button.dataset.mode, reportHtml: state.reportHtml })
    });
    const payload = await response.json();
    extensionOutput.textContent = payload.text || payload.message || "沒有內容";
  });
});

function showValidation(validation) {
  validationState.textContent = validation.ok ? "ok" : "issues";
  validationOutput.textContent = JSON.stringify(validation, null, 2);
}
