const command = document.getElementById("cmd");
const tabs = document.querySelectorAll(".tabs .tab");

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    command.textContent = tab.dataset.command;
    for (const button of tabs) {
      const selected = button === tab;
      button.classList.toggle("on", selected);
      button.setAttribute("aria-selected", String(selected));
    }
  });
}

const copy = document.getElementById("copy-cmd");
copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(command.textContent);
  copy.textContent = "copied";
  setTimeout(() => { copy.textContent = "copy"; }, 1200);
});
