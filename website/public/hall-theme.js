// Replace image with a local path, e.g. "images/halls/berkshire.webp".
// Defaults are the banners on each dining hall's official UMass Dining page.
const HALL_THEMES = {
  Berkshire: { image: "https://www.umassdining.com/sites/default/files/2025-02/10F.jpg", position: "center 52%", accent: "#9b541e", area: "Southwest Residential Area" },
  Worcester: { image: "https://www.umassdining.com/sites/default/files/2025-02/10P_0.jpg", position: "center 50%", accent: "#881c1c", area: "Northeast Residential Area" },
  Franklin: { image: "https://www.umassdining.com/sites/default/files/2025-02/10J_0.jpg", position: "center 50%", accent: "#35634b", area: "Central Residential Area" },
  Hampshire: { image: "https://www.umassdining.com/sites/default/files/2025-02/11B_0.jpg", position: "center 50%", accent: "#26646b", area: "Southwest Residential Area" },
};
let hallImageRequest = 0;
function applyHallTheme(hall) {
  const theme = HALL_THEMES[hall];
  if (!theme) return;
  const request = ++hallImageRequest;
  document.documentElement.style.setProperty("--hall-accent", theme.accent);
  document.documentElement.style.setProperty("--hall-position", theme.position);
  document.getElementById("hallTitle").textContent = `${hall} Dining Commons`;
  document.getElementById("hallArea").textContent = theme.area;
  const hero = document.getElementById("hallHero");
  const photo = document.getElementById("hallPhoto");
  hero.classList.remove("has-photo");
  photo.style.backgroundImage = "none";
  const image = new Image();
  image.onload = () => {
    if (request !== hallImageRequest) return;
    photo.style.backgroundImage = `url("${theme.image}")`;
    hero.classList.add("has-photo");
  };
  image.onerror = () => { if (request === hallImageRequest) hero.classList.remove("has-photo"); };
  image.src = theme.image;
}
