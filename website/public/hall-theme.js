// Per-hall theming for the hero. Each hall gets a local photo (served from
// public/images/), a distinct accent color that tints the hero and themes the
// page, and its residential-area label. The photo fades in over the accent
// gradient once it loads; if an image fails to load, the gradient remains as a
// graceful fallback.
const HALL_THEMES = {
  Berkshire: { image: "images/Berkshire.png", accent: "#9b541e", area: "Southwest Residential Area" },
  Worcester: { image: "images/Worcester.png", accent: "#881c1c", area: "Northeast Residential Area" },
  Franklin:  { image: "images/Franklin.png",  accent: "#35634b", area: "Central Residential Area" },
  Hampshire: { image: "images/Hampshire.png", accent: "#26646b", area: "Southwest Residential Area" },
};

let hallImageRequest = 0;

function applyHallTheme(hall) {
  const theme = HALL_THEMES[hall];
  if (!theme) return;
  const request = ++hallImageRequest;
  document.documentElement.style.setProperty("--hall-accent", theme.accent);
  const titleEl = document.getElementById("hallTitle");
  const areaEl = document.getElementById("hallArea");
  if (titleEl) titleEl.textContent = `${hall} Dining Commons`;
  if (areaEl) areaEl.textContent = theme.area;

  const hero = document.getElementById("hallHero");
  const photo = document.getElementById("hallPhoto");
  if (!hero || !photo) return;

  // Default: accent gradient only (no photo).
  hero.classList.remove("has-photo");
  photo.style.backgroundImage = "none";

  // Optional: fade in a local photo if one is configured for this hall.
  if (!theme.image) return;
  if (theme.position) {
    document.documentElement.style.setProperty("--hall-position", theme.position);
  }
  const image = new Image();
  image.onload = () => {
    if (request !== hallImageRequest) return;
    photo.style.backgroundImage = `url("${theme.image}")`;
    hero.classList.add("has-photo");
  };
  image.onerror = () => {
    if (request === hallImageRequest) hero.classList.remove("has-photo");
  };
  image.src = theme.image;
}
