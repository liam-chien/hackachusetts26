"""
U-Eat food-to-menu matching module.

Matches food components predicted by the Qwen vision model against UMass Dining
menu items using fuzzy string matching (RapidFuzz). The module is deterministic,
preserves per-component weights and source nutrition records, and classifies
each result as auto_match, needs_confirmation, or unmatched using conservative,
configurable thresholds.

This is lexical matching, not semantic understanding. Scores are similarities,
not probabilities. The module does not calculate nutrition totals, invent
nutrition values, merge components, or call an LLM, database, network service,
or image library.

Candidates: the top max_candidates (default 10) menu items are considered, and
only those scoring within candidate_score_window (default 10) points of the best
score are returned, inclusive. A menu name that contains every predicted word
("bean chili" -> "Vegetarian Bean Chili") is scored on word coverage alone, so
it outranks a name that merely looks similar ("Beef Chili"). Such a prediction
is never unmatched, and it is never auto-matched while the menu name has extra
words. Each candidate carries `contains_predicted_words` and `plausible` flags
so callers can tell real contenders from merely the closest names on the menu.

Known limitations: synonyms ("soda"/"pop"), plurals ("fries"/"fry"), and dishes
that differ by one crucial ingredient ("beef chili"/"bean chili") are not
understood. Such cases fall back to needs_confirmation or unmatched.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import unicodedata
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from rapidfuzz import fuzz

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class ConfigError(Exception):
    """Raised when a MatchConfig is constructed with invalid values."""


def _is_real_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@dataclass(frozen=True)
class MatchConfig:
    """Conservative, configurable matching thresholds (0-100 score scale).

    auto_match requires: best score >= auto_match_min_score, a lead of at
    least auto_match_min_margin over the closest other menu item, a prediction
    with at least min_specificity_tokens meaningful tokens, and a menu with at
    least two named items. A menu name that contains every predicted word
    plus extra words ("grilled chicken" -> "Grilled Chicken Breast") never
    auto-matches, because the prediction may be underspecified.

    Candidate output: the top max_candidates items are taken, and only those
    scoring at least (best score - candidate_score_window) are returned. A
    candidate is marked plausible when its name contains every predicted word
    or its score reaches candidate_floor_score. A prediction whose words all
    appear in a menu name is never unmatched.
    """

    auto_match_min_score: float = 88.0
    auto_match_min_margin: float = 12.0
    needs_confirmation_min_score: float = 55.0
    max_candidates: int = 10
    candidate_score_window: float = 10.0
    candidate_floor_score: float = 45.0
    min_specificity_tokens: int = 2

    # Higher values reduce the penalty for incomplete token coverage.
    # 1.0 means no coverage penalty; 0.0 means full coverage scaling.
    coverage_weight: float = 0.65

    def __post_init__(self) -> None:
        self._validate()

    def _validate(self) -> None:
        errors: List[str] = []

        for field_name in (
            "auto_match_min_score",
            "needs_confirmation_min_score",
            "candidate_floor_score",
        ):
            value = getattr(self, field_name)
            if not _is_real_number(value) or not math.isfinite(value):
                errors.append(f"{field_name} must be a finite number.")
            elif not 0 <= value <= 100:
                errors.append(f"{field_name} must be within 0-100.")

        for field_name in ("auto_match_min_margin", "candidate_score_window"):
            value = getattr(self, field_name)
            if not _is_real_number(value) or not math.isfinite(value):
                errors.append(f"{field_name} must be a finite number.")
            elif not 0 <= value <= 100:
                errors.append(f"{field_name} must be within 0-100.")

        if not _is_int(self.max_candidates) or self.max_candidates < 1:
            errors.append(
                "max_candidates must be a positive integer (booleans are not "
                "accepted)."
            )

        if (
            not _is_int(self.min_specificity_tokens)
            or self.min_specificity_tokens < 0
        ):
            errors.append(
                "min_specificity_tokens must be a non-negative integer "
                "(booleans are not accepted)."
            )

        cw = self.coverage_weight
        if (
            not _is_real_number(cw)
            or not math.isfinite(cw)
            or not 0 <= cw <= 1
        ):
            errors.append("coverage_weight must be a finite number within [0, 1].")

        confirm = self.needs_confirmation_min_score
        auto = self.auto_match_min_score
        if (
            _is_real_number(confirm)
            and _is_real_number(auto)
            and math.isfinite(confirm)
            and math.isfinite(auto)
            and confirm > auto
        ):
            errors.append(
                "needs_confirmation_min_score must be <= auto_match_min_score."
            )

        floor = self.candidate_floor_score
        if (
            _is_real_number(floor)
            and _is_real_number(confirm)
            and math.isfinite(floor)
            and math.isfinite(confirm)
            and floor > confirm
        ):
            errors.append(
                "candidate_floor_score must be <= needs_confirmation_min_score."
            )

        if errors:
            raise ConfigError(" ".join(errors))


DEFAULT_CONFIG = MatchConfig()

STATUS_AUTO = "auto_match"
STATUS_CONFIRM = "needs_confirmation"
STATUS_UNMATCHED = "unmatched"


class MatcherError(Exception):
    """Raised for unrecoverable input, schema, or output problems."""

# ---------------------------------------------------------------------------
# Normalization and scoring
# ---------------------------------------------------------------------------


_STOPWORDS = {"with", "and", "the", "of", "a", "an", "in", "on", "side"}

# Anything that is not a letter or digit (in any script) separates tokens.
# Underscore is included because \w would otherwise keep it.
_NON_WORD_RE = re.compile(r"[\W_]+")


def _fold(text: str) -> str:
    """Case-fold and strip accents: 'Crème Brûlée' -> 'creme brulee'."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize_tokens(name: Optional[str]) -> List[str]:
    """Normalize a name into case-folded, accent-free tokens.

    Punctuation and whitespace separate tokens. A small stopword set is
    removed unless that would leave nothing. Returns [] for non-strings and
    names with no letters or digits.
    """
    if not isinstance(name, str):
        return []

    cleaned = _NON_WORD_RE.sub(" ", _fold(name)).strip()
    if not cleaned:
        return []

    tokens = [token for token in cleaned.split() if token not in _STOPWORDS]
    return tokens or cleaned.split()


def normalize_name(name: Optional[str]) -> str:
    """Return a stable, order-insensitive normalized name."""
    return " ".join(sorted(normalize_tokens(name)))


def _coverage(pred_tokens: List[str], cand_tokens: List[str]) -> float:
    """Shared unique-token fraction relative to the larger token set."""
    if not pred_tokens or not cand_tokens:
        return 0.0

    predicted = set(pred_tokens)
    candidate = set(cand_tokens)
    return len(predicted & candidate) / max(len(predicted), len(candidate))


def _contains_prediction(pred_tokens: List[str], cand_tokens: List[str]) -> bool:
    """True when every word of the prediction appears as a whole word in the
    candidate name, e.g. "chicken" in "Grilled Chicken Breast".

    The prediction must contain at least one letter-bearing word, so a bare
    number such as "2" never counts as contained.
    """
    if not any(any(ch.isalpha() for ch in token) for token in pred_tokens):
        return False
    return set(pred_tokens) <= set(cand_tokens)


def score_names(
    predicted: str,
    candidate: str,
    coverage_weight: Optional[float] = None,
    config: Optional[MatchConfig] = None,
) -> float:
    """
    Return a lexical similarity score on a 0-100 scale.

    `base` is RapidFuzz's ratio on the sorted, order-insensitive names
    (equivalent to token_sort_ratio). When the candidate name contains every
    predicted word, `base` is 100: the words match exactly, so only the
    candidate's extra words should lower the score. It is combined with token
    coverage:

        score = base * (weight + (1 - weight) * coverage)

    Examples with the default weight 0.65:
      "bean chili" vs "Vegetarian Bean Chili"   contains, coverage 2/3 -> 88.33
      "bean chili" vs "Beef Chili"              ratio 80, coverage 1/2 -> 66.0
      "chicken"    vs "Grilled Chicken Breast"  contains, coverage 1/3 -> 76.67

    weight=1.0 disables the coverage penalty; weight=0.0 scales the score
    entirely by coverage. Scores are not probabilities or proof of equivalence.
    """
    if coverage_weight is None:
        coverage_weight = (
            config.coverage_weight if config is not None
            else DEFAULT_CONFIG.coverage_weight
        )

    if (
        not _is_real_number(coverage_weight)
        or not math.isfinite(coverage_weight)
        or not 0.0 <= coverage_weight <= 1.0
    ):
        raise ValueError("coverage_weight must be a finite number within [0, 1].")

    pred_tokens = normalize_tokens(predicted)
    cand_tokens = normalize_tokens(candidate)

    if not pred_tokens or not cand_tokens:
        return 0.0

    pred_norm = " ".join(sorted(pred_tokens))
    cand_norm = " ".join(sorted(cand_tokens))

    if _contains_prediction(pred_tokens, cand_tokens):
        base = 100.0
    else:
        base = float(fuzz.ratio(pred_norm, cand_norm))
    cov = _coverage(pred_tokens, cand_tokens)
    score = base * (coverage_weight + (1.0 - coverage_weight) * cov)

    return round(float(score), 2)


def _meaningful_token_count(name: Optional[str]) -> int:
    """Count tokens containing at least one letter.

    Bare numbers (the "2" in "2 eggs") do not make a prediction more specific.
    """
    return sum(
        1 for token in normalize_tokens(name)
        if any(ch.isalpha() for ch in token)
    )

# ---------------------------------------------------------------------------
# Weight validation
# ---------------------------------------------------------------------------


def _coerce_weight(value: Any) -> Tuple[Optional[float], bool]:
    """
    Return (weight, valid). Accept finite, non-negative numbers and numeric
    strings. Reject booleans, missing values, negative values, NaN, infinity,
    and integers too large to represent as a float.

    Zero is accepted as valid (e.g. a garnish the model saw but weighed at
    ~0 g). Invalid weights are returned as None and never replaced with an
    estimate.
    """
    if value is None or isinstance(value, bool):
        return None, False

    try:
        if isinstance(value, (int, float)):
            weight = float(value)
        elif isinstance(value, str):
            weight = float(value.strip())
        else:
            return None, False
    except (ValueError, OverflowError):
        return None, False

    if not math.isfinite(weight) or weight < 0:
        return None, False

    return weight, True

# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------


def load_json_file(path: str) -> Any:
    """Load JSON, raising MatcherError for file, encoding, or parse failures.

    Files are read as UTF-8; a leading UTF-8 byte-order mark is accepted.
    """
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise MatcherError(f"Input file not found: {path}") from exc
    except UnicodeDecodeError as exc:
        raise MatcherError(f"{path} is not valid UTF-8: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise MatcherError(f"Malformed JSON in {path}: {exc}") from exc
    except OSError as exc:
        raise MatcherError(f"Could not read {path}: {exc}") from exc


def parse_qwen_foods(
    qwen_data: Any,
) -> Tuple[List[Dict[str, Any]], int]:
    """Parse Qwen food components and count skipped non-object entries."""
    if isinstance(qwen_data, dict):
        if "foods" not in qwen_data:
            raise MatcherError("Qwen input is missing the 'foods' field.")
        raw_foods = qwen_data["foods"]
    elif isinstance(qwen_data, list):
        raw_foods = qwen_data
    else:
        raise MatcherError("Qwen input must be an object or an array.")

    if not isinstance(raw_foods, list):
        raise MatcherError("Qwen 'foods' must be an array.")

    foods: List[Dict[str, Any]] = []
    skipped = 0

    for entry in raw_foods:
        if not isinstance(entry, dict):
            skipped += 1
            continue

        name = entry.get("name")
        if not isinstance(name, str):
            name = None

        weight, valid = _coerce_weight(entry.get("weight_g"))
        foods.append({
            "name": name,
            "weight_g": weight,
            "weight_valid": valid,
            "raw": entry,
        })

    return foods, skipped


@dataclass
class MenuItem:
    """One menu item with its original nutrition record."""
    item_id: Optional[str]
    name: Optional[str]
    nutrition: Any
    raw: Dict[str, Any]


def parse_menu(menu_data: Any) -> Tuple[List[MenuItem], int]:
    """Parse menu items and count skipped non-object entries."""
    if isinstance(menu_data, dict):
        if "items" not in menu_data:
            raise MatcherError("Menu input is missing the 'items' field.")
        raw_items = menu_data["items"]
    elif isinstance(menu_data, list):
        raw_items = menu_data
    else:
        raise MatcherError("Menu input must be an object or an array.")

    if not isinstance(raw_items, list):
        raise MatcherError("Menu 'items' must be an array.")

    items: List[MenuItem] = []
    skipped = 0

    for entry in raw_items:
        if not isinstance(entry, dict):
            skipped += 1
            continue

        item_id = entry.get("id")
        if item_id is not None and not isinstance(item_id, str):
            item_id = str(item_id)

        name = entry.get("name")
        if not isinstance(name, str):
            name = None

        items.append(MenuItem(
            item_id=item_id,
            name=name,
            nutrition=entry.get("nutrition_per_100g"),
            raw=entry,
        ))

    return items, skipped


def menu_metadata(menu_data: Any) -> Dict[str, Any]:
    """Return optional menu-level metadata."""
    if not isinstance(menu_data, dict):
        return {"date": None, "dining_hall": None, "meal": None}

    return {
        "date": menu_data.get("date"),
        "dining_hall": menu_data.get("dining_hall"),
        "meal": menu_data.get("meal"),
    }

# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def _rank_candidates(
    predicted_name: Optional[str],
    menu_items: List[MenuItem],
    config: MatchConfig,
) -> List[Dict[str, Any]]:
    """
    Score EVERY named menu item and return them in deterministic order.

    Items are ordered by score (highest first); on equal scores, items whose
    name contains every predicted word come first, then by name and id.
    Each candidate is flagged:

      contains_predicted_words  every predicted word appears in its name
      plausible                 contains_predicted_words, or score reaches
                                candidate_floor_score

    Nothing is filtered here, so the auto-match margin can be measured against
    the closest competitor even when that competitor is weak.
    """
    pred_tokens = normalize_tokens(predicted_name)
    scored: List[Dict[str, Any]] = []

    for item in menu_items:
        if not item.name:
            continue

        score = score_names(predicted_name or "", item.name, config=config)
        contains = _contains_prediction(pred_tokens, normalize_tokens(item.name))
        scored.append({
            "id": item.item_id,
            "name": item.name,
            "score": score,
            "contains_predicted_words": contains,
            "plausible": contains or score >= config.candidate_floor_score,
            "nutrition_per_100g": item.nutrition,
            "_sort_key": (
                -score,
                not contains,
                normalize_name(item.name),
                item.item_id or "",
            ),
        })

    scored.sort(key=lambda candidate: candidate["_sort_key"])

    for candidate in scored:
        del candidate["_sort_key"]

    return scored


def _classify(
    predicted_name: Optional[str],
    all_scored: List[Dict[str, Any]],
    config: MatchConfig,
) -> Tuple[str, str]:
    """Classify using every scored menu item in ranked order."""
    if not all_scored:
        return (
            STATUS_UNMATCHED,
            "No menu item has a usable name to match against.",
        )

    best = all_scored[0]
    best_score = best["score"]
    contains = best["contains_predicted_words"]

    if best_score < config.needs_confirmation_min_score and not contains:
        return (
            STATUS_UNMATCHED,
            f"No menu item contains every word of '{predicted_name}', and "
            f"the closest name '{best['name']}' scored {best_score:.1f}, "
            f"below the confirmation threshold "
            f"({config.needs_confirmation_min_score:.1f}). Candidates listed "
            "are only the closest names on the menu.",
        )

    if best_score < config.needs_confirmation_min_score:
        containing = sum(1 for c in all_scored if c["contains_predicted_words"])
        return (
            STATUS_CONFIRM,
            f"Every word of '{predicted_name}' appears in '{best['name']}' "
            f"({containing} menu item(s) contain it), but the names differ "
            "too much to choose automatically.",
        )

    specificity = _meaningful_token_count(predicted_name)
    if specificity < config.min_specificity_tokens:
        return (
            STATUS_CONFIRM,
            f"Prediction '{predicted_name}' is too generic "
            f"({specificity} meaningful token(s)); candidate "
            f"'{best['name']}' requires confirmation.",
        )

    if len(all_scored) < 2:
        return (
            STATUS_CONFIRM,
            f"The menu has only one named item ('{best['name']}'); with "
            "nothing to compare against, a high score alone does not "
            "justify auto-matching.",
        )

    if contains:
        extra_words = sorted(
            set(normalize_tokens(best["name"])) - set(normalize_tokens(predicted_name))
        )
        if extra_words:
            return (
                STATUS_CONFIRM,
                f"'{best['name']}' contains every word of '{predicted_name}' "
                f"(score {best_score:.1f}) but adds "
                f"{', '.join(repr(w) for w in extra_words)}; the prediction "
                "may be less specific than the dish, so it needs confirmation.",
            )

    runner_up_score = all_scored[1]["score"]
    margin = best_score - runner_up_score

    if (
        best_score >= config.auto_match_min_score
        and margin >= config.auto_match_min_margin
    ):
        return (
            STATUS_AUTO,
            f"Top candidate '{best['name']}' scored {best_score:.1f} and "
            f"beat the closest other menu item by {margin:.1f}.",
        )

    if best_score < config.auto_match_min_score:
        reason = (
            f"Best candidate '{best['name']}' scored {best_score:.1f}, "
            f"below the auto-match threshold "
            f"({config.auto_match_min_score:.1f})."
        )
    else:
        reason = (
            f"Top candidate '{best['name']}' leads by {margin:.1f}, "
            f"below the required margin ({config.auto_match_min_margin:.1f})."
        )

    return STATUS_CONFIRM, reason


def _add_weight_warning(
    explanation: str,
    component: Dict[str, Any],
) -> str:
    if not component.get("weight_valid", False):
        return (
            explanation
            + " Note: estimated weight is missing or invalid and was not "
              "substituted."
        )
    return explanation


def match_component(
    component: Dict[str, Any],
    menu_items: List[MenuItem],
    config: MatchConfig,
) -> Dict[str, Any]:
    """Match one food component without merging or modifying it."""
    predicted_name = component.get("name")

    result: Dict[str, Any] = {
        "predicted_name": predicted_name,
        "estimated_weight_g": component.get("weight_g"),
        "weight_valid": component.get("weight_valid", False),
        "status": STATUS_UNMATCHED,
        "candidates": [],
        "explanation": "",
    }

    if not predicted_name or not normalize_tokens(predicted_name):
        result["explanation"] = _add_weight_warning(
            "Predicted component has no usable name; cannot match.",
            component,
        )
        return result

    if not menu_items:
        result["explanation"] = _add_weight_warning(
            "Menu contains no items to match against.",
            component,
        )
        return result

    all_scored = _rank_candidates(predicted_name, menu_items, config)
    status, explanation = _classify(predicted_name, all_scored, config)

    # Take the top max_candidates, then keep only those within the score
    # window of the best (inclusive). Rounding avoids float noise such as
    # 82.56 - 10 = 72.56000000000001 excluding a 72.56 candidate.
    top = all_scored[:config.max_candidates]
    if top:
        cutoff = round(top[0]["score"] - config.candidate_score_window, 2)
        displayed_candidates = [c for c in top if c["score"] >= cutoff]
    else:
        displayed_candidates = []

    explanation = _add_weight_warning(explanation, component)

    result["status"] = status
    result["candidates"] = displayed_candidates
    result["explanation"] = explanation

    return result


def match_foods_to_menu(
    qwen_data: Any,
    menu_data: Any,
    config: MatchConfig = DEFAULT_CONFIG,
) -> Dict[str, Any]:
    """Match all components and report summary and input warnings."""
    components, qwen_skipped = parse_qwen_foods(qwen_data)
    menu_items, menu_skipped = parse_menu(menu_data)
    metadata = menu_metadata(menu_data)

    results = [
        match_component(component, menu_items, config)
        for component in components
    ]

    summary = {
        STATUS_AUTO: 0,
        STATUS_CONFIRM: 0,
        STATUS_UNMATCHED: 0,
    }
    for result in results:
        summary[result["status"]] += 1

    return {
        "menu": {
            "date": metadata["date"],
            "dining_hall": metadata["dining_hall"],
            "meal": metadata["meal"],
            "item_count": len(menu_items),
        },
        "config": {
            "auto_match_min_score": config.auto_match_min_score,
            "auto_match_min_margin": config.auto_match_min_margin,
            "needs_confirmation_min_score": (
                config.needs_confirmation_min_score
            ),
            "candidate_floor_score": config.candidate_floor_score,
            "min_specificity_tokens": config.min_specificity_tokens,
            "coverage_weight": config.coverage_weight,
            "max_candidates": config.max_candidates,
            "candidate_score_window": config.candidate_score_window,
        },
        "input_warnings": {
            "qwen_skipped_entries": qwen_skipped,
            "menu_skipped_entries": menu_skipped,
        },
        "component_count": len(results),
        "summary": summary,
        "results": results,
    }


def dump_results(results: Dict[str, Any], ensure_ascii: bool = False) -> str:
    """Serialize results as standard JSON.

    Nutrition records are preserved exactly, so a source value of NaN or
    Infinity cannot be rewritten. Standard JSON cannot represent those values,
    so this raises MatcherError instead of writing invalid JSON.

    ensure_ascii=True escapes non-ASCII characters as \\uXXXX. The result is
    still valid JSON and decodes to the same text.
    """
    try:
        return json.dumps(
            results, indent=2, ensure_ascii=ensure_ascii, allow_nan=False
        )
    except ValueError as exc:
        raise MatcherError(
            "Results contain NaN or Infinity (usually from menu nutrition "
            "data), which cannot be written as standard JSON. Fix the source "
            "menu file."
        ) from exc

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Match Qwen-predicted foods against a UMass Dining menu."
    )
    parser.add_argument("qwen_path", help="Path to Qwen output JSON.")
    parser.add_argument("menu_path", help="Path to menu JSON.")
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Output JSON path. Defaults to stdout.",
    )
    parser.add_argument(
        "--auto-score",
        type=float,
        default=DEFAULT_CONFIG.auto_match_min_score,
        help="Minimum score for auto-match.",
    )
    parser.add_argument(
        "--auto-margin",
        type=float,
        default=DEFAULT_CONFIG.auto_match_min_margin,
        help="Minimum lead over the closest other menu item for auto-match.",
    )
    parser.add_argument(
        "--confirm-score",
        type=float,
        default=DEFAULT_CONFIG.needs_confirmation_min_score,
        help="Minimum score for a plausible candidate.",
    )
    parser.add_argument(
        "--candidate-floor",
        type=float,
        default=DEFAULT_CONFIG.candidate_floor_score,
        help="Score at which a candidate is marked plausible even if its "
             "name does not contain every predicted word.",
    )
    parser.add_argument(
        "--min-specificity",
        type=int,
        default=DEFAULT_CONFIG.min_specificity_tokens,
        help="Minimum meaningful (letter-containing) tokens for auto-match.",
    )
    parser.add_argument(
        "--coverage-weight",
        type=float,
        default=DEFAULT_CONFIG.coverage_weight,
        help="Coverage-penalty blend weight in [0, 1]; 1 disables the penalty.",
    )
    parser.add_argument(
        "--max-candidates",
        type=int,
        default=DEFAULT_CONFIG.max_candidates,
        help="Number of top-ranked menu items considered per component "
             "(default: %(default)s).",
    )
    parser.add_argument(
        "--score-window",
        type=float,
        default=DEFAULT_CONFIG.candidate_score_window,
        help="Return only candidates scoring within this many points of the "
             "best candidate, inclusive (default: %(default)s).",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    try:
        config = MatchConfig(
            auto_match_min_score=args.auto_score,
            auto_match_min_margin=args.auto_margin,
            needs_confirmation_min_score=args.confirm_score,
            candidate_floor_score=args.candidate_floor,
            min_specificity_tokens=args.min_specificity,
            coverage_weight=args.coverage_weight,
            max_candidates=args.max_candidates,
            candidate_score_window=args.score_window,
        )
    except ConfigError as exc:
        print(f"Invalid configuration: {exc}", file=sys.stderr)
        return 2

    try:
        qwen_data = load_json_file(args.qwen_path)
        menu_data = load_json_file(args.menu_path)
        results = match_foods_to_menu(qwen_data, menu_data, config)
        payload = dump_results(results)
    except MatcherError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.write("\n")
        except OSError as exc:
            print(f"Error writing output: {exc}", file=sys.stderr)
            return 2
        print(f"Wrote match results to {args.output}")
    else:
        try:
            print(payload)
        except UnicodeEncodeError:
            # The console cannot encode non-ASCII names (e.g. some Windows
            # code pages). Escaped output is still valid, equivalent JSON.
            print(dump_results(results, ensure_ascii=True))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
