const mode = document.currentScript.dataset.mode; // "login" | "setup"
const form = document.getElementById("f");
const err = document.getElementById("err");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed");
    location.href = "/";
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    btn.disabled = false;
  }
});
