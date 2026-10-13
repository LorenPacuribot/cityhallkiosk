#!/usr/bin/env python3
"""
Parse the City of Malaybalay 2023 Citizen's Charter (pdftotext -layout output)
into structured JSON for seeding the kiosk database.

Usage:
    pdftotext -layout Citizens-Charter-2023.pdf charter.txt
    python3 tools/parse_charter.py charter.txt server/data/charter-2023.json

The parser is heuristic: the charter is a designed PDF, not a data file.
Every service it outputs carries `parse_quality` and `source_page` so staff can
verify it in the admin panel before publishing. Never publish unverified data.
"""
import json
import re
import sys
from collections import OrderedDict

FOOTER_PATTERNS = [
    r"2023 CITIZEN", r"Cool Weather", r"Warm People", r"OFFICE HOURS", r"Monday to Friday",
    r"\(except on holidays\)", r"^\s*\d{1,3}\s*$", r"^\s*[ivxlc]+\s*$",
]
FOOTER_RE = re.compile("|".join(FOOTER_PATTERNS), re.I)


def clean(s):
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip()


def segments(line):
    """Split a layout line into (start_col, text) chunks separated by 2+ spaces."""
    out = []
    for m in re.finditer(r"\S(?:.*?\S)?(?=\s{2,}|$)", line):
        out.append((m.start(), m.group(0)))
    return out


# --------------------------------------------------------------------------- TOC
def parse_toc(lines):
    start = next(i for i, l in enumerate(lines) if l.strip() == "List of Services")
    end = next(i for i in range(start, len(lines)) if lines[i].strip().startswith("List of Offices"))
    offices = []
    current = None
    pending = None
    for raw in lines[start + 1:end]:
        if not raw.strip() or FOOTER_RE.search(raw) and not re.search(r"\s{3,}\d+\s*$", raw):
            continue
        indent = len(raw) - len(raw.lstrip())
        text = raw.strip()
        m = re.match(r"(.*?)\s{2,}(\d+)$", text)
        if indent == 0 and not m:
            current = {"name": clean(text), "services": []}
            offices.append(current)
            pending = None
            continue
        if current is None:
            continue
        if indent >= 8 and not m and pending is None and current["services"]:
            current["services"][-1]["title"] = clean(current["services"][-1]["title"] + " " + text)
            continue
        if m:
            title = clean(((pending + " ") if pending else "") + m.group(1))
            current["services"].append({"title": title, "page": int(m.group(2))})
            pending = None
        else:
            pending = clean(((pending + " ") if pending else "") + text)
    return offices


# ------------------------------------------------------------------ SERVICE BODY
LEFT_LABELS = ["Description of Service", "Office and Division", "Classification", "Type of Transaction", "Who May Avail"]
RIGHT_LABELS = ["Total Processing Time", "Total Fees", "Period of Extension"]


def parse_header(block):
    """block: list of raw lines from title to 'Documentary Requirements'."""
    fields = {k: [] for k in LEFT_LABELS + RIGHT_LABELS}
    # find right label column
    right_col = None
    for l in block:
        for lab in RIGHT_LABELS:
            i = l.find(lab)
            if i > 40:
                right_col = i if right_col is None else min(right_col, i)
    label_lines_left, label_lines_right = {}, {}
    for idx, l in enumerate(block):
        for lab in LEFT_LABELS:
            if l.lstrip().startswith(lab) and (len(l) - len(l.lstrip())) < 4:
                label_lines_left[idx] = lab
        for lab in RIGHT_LABELS:
            i = l.find(lab)
            if i > 40:
                label_lines_right[idx] = (lab, i)

    def assign(label_lines, col_from, col_to, value_offset_fn):
        if not label_lines:
            return
        keys = sorted(label_lines)
        for idx, l in enumerate(block):
            seg = l[col_from:col_to] if col_to else l[col_from:]
            if idx in label_lines:
                lab = label_lines[idx] if isinstance(label_lines[idx], str) else label_lines[idx][0]
                val = value_offset_fn(l, label_lines[idx])
            else:
                if not seg.strip():
                    continue
                # nearest label line; ties go to the following label (labels are vertically centred)
                nearest = min(keys, key=lambda k: (abs(k - idx), 0 if k > idx else 1))
                lab = label_lines[nearest] if isinstance(label_lines[nearest], str) else label_lines[nearest][0]
                val = seg
            if val and val.strip():
                fields[lab].append((idx, val.strip()))

    left_end = right_col if right_col else None

    def left_val(l, lab):
        s = l[:left_end] if left_end else l
        j = s.find(lab)
        return s[j + len(lab):] if j >= 0 else ""

    def right_val(l, labinfo):
        lab, i = labinfo
        return l[i + len(lab):]

    office_idx = next((i for i, v in label_lines_left.items() if v == "Office and Division"), None)
    if office_idx is not None:
        desc_lab = next((i for i, v in label_lines_left.items() if v == "Description of Service"), None)
        desc = []
        for idx in range(0, office_idx):
            l = block[idx].replace("Description of Service", " " * len("Description of Service"))
            if l.strip():
                desc.append((idx, l.strip()))
        fields["Description of Service"] = desc
        rest = {i: v for i, v in label_lines_left.items() if i >= office_idx}
        sub = block[office_idx:]
        def shift(d):
            return {i - office_idx: v for i, v in d.items() if i >= office_idx}
        block[:] = sub
        assign(shift(rest), 0, left_end, left_val)
        if right_col:
            assign(shift(label_lines_right), right_col, None, right_val)
    else:
        assign(label_lines_left, 0, left_end, left_val)
        if right_col:
            assign(label_lines_right, right_col, None, right_val)
    out = {}
    for k, v in fields.items():
        v.sort()
        out[k] = clean(" ".join(x[1] for x in v))
    return out


def parse_requirements(lines):
    reqs = []
    header = next((i for i, l in enumerate(lines) if "Documentary Requirements" in l), None)
    if header is None:
        return reqs
    where_col = lines[header].find("Where to Secure")
    for l in lines[header + 1:]:
        if re.search(r"Client\s+Action|Client Steps|CLIENT STEPS", l, re.I):
            break
        if not l.strip() or FOOTER_RE.search(l):
            continue
        left = l[:where_col].strip() if where_col > 0 else l.strip()
        right = l[where_col:].strip() if where_col > 0 else ""
        if left:
            cont = reqs and (left[0].islower() or left[0] in "(&,-/" or reqs[-1]["requirement"].endswith((",", "and", "or", "of", "the", "-", "/")))
            if cont:
                reqs[-1]["requirement"] = clean(reqs[-1]["requirement"] + " " + left)
                if right:
                    reqs[-1]["where_to_secure"] = clean(reqs[-1]["where_to_secure"] + " " + right)
            else:
                reqs.append({"requirement": clean(left), "where_to_secure": clean(right)})
        elif right and reqs:
            reqs[-1]["where_to_secure"] = clean(reqs[-1]["where_to_secure"] + " " + right)
    return [r for r in reqs if r["requirement"] and not r["requirement"].lower().startswith("none") or r["requirement"].lower() == "none"]


COLS = ["client", "agency", "fee", "time", "person", "contact"]


def parse_steps(lines):
    steps = []
    centers = None
    cur = None
    for i, l in enumerate(lines):
        if re.search(r"Client\s+Action", l) and re.search(r"Agency\s+Action", l):
            def c(word):
                j = l.find(word)
                return j + len(word) / 2 if j >= 0 else None
            centers = {
                "client": c("Client Action"), "agency": c("Agency Action"),
                "fee": c("Fees to be") or c("Fees"), "time": c("Processing"),
                "person": c("Person in-Charge") or c("Person"), "contact": c("Contact"),
            }
            centers = {k: v for k, v in centers.items() if v is not None}
            continue
        if centers is None:
            continue
        if not l.strip() or FOOTER_RE.search(l) or "(Detailed Steps)" in l or re.search(r"\(Position/Unit", l):
            continue
        if re.search(r"End of Transaction", l, re.I):
            break
        if re.match(r"^\s*Total\b", l.strip()) or re.search(r"\s{5,}Total\s{2,}", l):
            continue
        row = {k: "" for k in COLS}
        for start, text in segments(l):
            mid = start + len(text) / 2
            col = min(centers, key=lambda k: abs(centers[k] - mid))
            # long text that starts in the client area belongs to client/agency, not fee/time
            if col in ("fee", "time") and len(text) > 22:
                col = "agency"
            row[col] = (row[col] + " " + text).strip()
        is_client_start = re.match(r"^\d+\.(?!\d)", row["client"])
        is_agency_start = re.match(r"^\d+\.\d+", row["agency"])
        if is_client_start or cur is None:
            cur = {"client_action": "", "agency_actions": []}
            steps.append(cur)
        if is_agency_start or (not cur["agency_actions"] and row["agency"]):
            cur["agency_actions"].append({k: "" for k in ["agency_action", "fee", "time", "person"]})
        if row["client"]:
            cur["client_action"] = clean(cur["client_action"] + " " + re.sub(r"^\d+\.\s*", "", row["client"]) if is_client_start else cur["client_action"] + " " + row["client"])
        if cur["agency_actions"]:
            a = cur["agency_actions"][-1]
            if row["agency"]:
                a["agency_action"] = clean(a["agency_action"] + " " + re.sub(r"^\d+\.\d+\.?\s*", "", row["agency"]))
            for k in ("fee", "time", "person"):
                if row[k]:
                    a[k] = clean(a[k] + " " + row[k])
    # drop empty
    return [s for s in steps if s["client_action"] or s["agency_actions"]]


def main(src, dst):
    text = open(src, encoding="utf-8").read()
    pages = text.split("\f")
    lines, page_of = [], []
    for pi, p in enumerate(pages):
        for l in p.split("\n"):
            lines.append(l.rstrip())
            page_of.append(pi + 1)

    toc = parse_toc(lines)
    # body services: a numbered title line followed (within 8 lines) by "Description of Service"
    body_start = next(i for i, l in enumerate(lines) if re.match(r"^1\.\s+Pre-Audit", l.strip()))
    starts = []
    for i in range(body_start, len(lines)):
        m = re.match(r"^\s{0,6}(\d{1,3})\.\s+(\S.*)$", lines[i])
        if m and any("Description of Service" in lines[j] for j in range(i, min(i + 9, len(lines)))):
            if not re.search(r"\s{3,}\S", m.group(2)):  # not a table row
                starts.append((i, int(m.group(1)), clean(m.group(2))))
    end_body = next(i for i, l in enumerate(lines) if l.strip() == "LIST OF OFFICES")

    services = []
    for k, (i, num, title) in enumerate(starts):
        j = starts[k + 1][0] if k + 1 < len(starts) else end_body
        block = [l for l in lines[i + 1:j] if not FOOTER_RE.search(l)]
        req_i = next((x for x, l in enumerate(block) if "Documentary Requirements" in l), len(block))
        header = parse_header(block[:req_i])
        reqs = parse_requirements(block)
        steps = parse_steps(block)
        # title may wrap onto next line(s) before description begins
        hours = ""
        for l in lines[i:j]:
            m = re.search(r"(Monday to \w+.*?(?:PM|NN))", l)
            if m:
                hours = clean(m.group(1)); break
        q = "good"
        odd = re.compile(r"Cool Weather|CITIZEN'S CHARTER|OFFICE HOURS|to be Paid")
        if (not header.get("Office and Division") or not steps or len(header.get("Description of Service", "")) > 700
                or any(odd.search(v or "") for v in header.values())
                or len(header.get("Total Processing Time", "")) > 60 or len(header.get("Total Fees", "")) > 80):
            q = "needs_review"
        services.append({
            "number": num, "title": title, "source_page": page_of[i],
            "description": header.get("Description of Service", ""),
            "office_and_division": header.get("Office and Division", ""),
            "classification": header.get("Classification", ""),
            "transaction_type": header.get("Type of Transaction", ""),
            "who_may_avail": header.get("Who May Avail", ""),
            "total_processing_time": header.get("Total Processing Time", ""),
            "total_fees": header.get("Total Fees", ""),
            "period_of_extension": header.get("Period of Extension", ""),
            "office_hours": hours,
            "requirements": reqs, "steps": steps, "parse_quality": q,
        })

    # Align body services to TOC entries (same order, but the TOC has a few extra/duplicate lines).
    import difflib
    flat = [(o["name"], s["title"]) for o in toc for s in o["services"]]
    ptr = 0
    for s in services:
        best, bi = 0, None
        for k in range(ptr, min(ptr + 8, len(flat))):
            r = difflib.SequenceMatcher(None, s["title"].lower()[:60], flat[k][1].lower()[:60]).ratio()
            if r > best:
                best, bi = r, k
        if bi is not None and best > 0.55:
            s["office"], s["toc_title"] = flat[bi]
            ptr = bi + 1
        else:
            s["office"], s["toc_title"] = (flat[ptr - 1][0] if ptr else None), None

    # List of offices (address/phone)
    lo = next(i for i, l in enumerate(lines) if l.strip() == "LIST OF OFFICES")
    fb = next(i for i in range(lo, len(lines)) if l_strip(lines[i]) == "FEEDBACK AND COMPLAINTS MECHANISM")
    office_list = []
    for l in lines[lo:fb]:
        segs = segments(l)
        if len(segs) >= 2 and re.search(r"\(088\)", l):
            name = segs[0][1]
            addr = " ".join(t for _, t in segs[1:-1])
            office_list.append({"name": clean(name), "address": clean(addr), "phone": clean(segs[-1][1])})
        elif len(segs) == 1 and office_list and segs[0][0] > 30 and "Malaybalay" in segs[0][1]:
            office_list[-1]["address"] = clean(office_list[-1]["address"] + " " + segs[0][1])
    out = OrderedDict(source="City Government of Malaybalay Citizen's Charter, 2023 1st Edition",
                      toc=toc, office_directory=office_list, services=services)
    json.dump(out, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    good = sum(1 for s in services if s["parse_quality"] == "good")
    print(f"TOC offices={len(toc)} toc_services={len(flat)} body_services={len(services)} good={good} offices_listed={len(office_list)}")


def l_strip(s):
    return s.strip()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
