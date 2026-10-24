// Per-hall theming for the hero. Each hall gets a distinct accent color and
// its residential-area label. We intentionally do NOT hotlink external photos:
// the previously used umassdining.com banner images were generic marketing
// shots (one showed non-UMass apparel) and loading them cross-origin on every
// hall switch was fragile. The hero uses an accent gradient instead.
//
// To use real, hall-specific photography later: drop files into a local
// "images/halls/" folder and set `image` below to e.g. "images/halls/berkshire.webp".
// The code will fade the photo in over the gradient when it loads.
const HALL_THEMES = {
  Berkshire: { accent: "#9b541e", area: "Southwest Residential Area" },
  Worcester: { accent: "#881c1c", area: "Northeast Residential Area" },
  Franklin:  { accent: "#35634b", area: "Central Residential Area" },
  Hampshire: { accent: "#26646b", area: "Southwest Residential Area" },
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
