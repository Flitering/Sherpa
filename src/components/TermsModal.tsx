import terms from "../../TERMS.md?raw";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Строка markdown → HTML: жирный, код, ссылки (внешние открываются в браузере). */
const inline = (s: string) =>
    esc(s)
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

/** Небольшой разбор markdown условий: заголовки, абзацы, списки, таблица. */
function render(md: string): string {
    const out: string[] = [];
    const lines = md.replace(/\r/g, "").split("\n");
    let para: string[] = [];
    let list: string[] | null = null;
    let table: string[][] | null = null;
    const flush = () => {
        if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
        para = [];
        if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
        list = null;
        if (table) {
            const [head, ...rows] = table;
            out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        }
        table = null;
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.trim()) {
            flush();
            continue;
        }
        if (line.startsWith("# ")) continue; // заголовок окна уже есть
        const h = /^##\s+(.*)/.exec(line);
        if (h) {
            flush();
            out.push(`<h4>${inline(h[1])}</h4>`);
            continue;
        }
        if (line.startsWith("|")) {
            if (para.length || list) flush();
            const cells = line.split("|").slice(1, -1).map((c) => c.trim());
            if (cells.every((c) => /^-+$/.test(c))) continue;
            (table ??= []).push(cells);
            continue;
        }
        const li = /^\s*-\s+(.*)/.exec(line);
        if (li) {
            if (para.length) flush();
            if (/^\s{2,}-/.test(line) && list?.length) list[list.length - 1] += "<br>— " + li[1];
            else (list ??= []).push(li[1]);
            continue;
        }
        if (list && /^\s{2,}/.test(line)) list[list.length - 1] += " " + line.trim();
        else para.push(line.trim());
    }
    flush();
    return out.join("\n");
}

const HTML = render(terms);

/** Окно с условиями использования. */
export default function TermsModal({ onClose }: { onClose: () => void }) {
    return (
        <div className="modal-back" onClick={onClose}>
            <div className="modal terms" onClick={(e) => e.stopPropagation()}>
                <div className="wiz-head">
                    <b>Условия использования</b>
                    <button className="link" onClick={onClose}>
                        закрыть
                    </button>
                </div>
                <div className="terms-body" dangerouslySetInnerHTML={{ __html: HTML }} />
            </div>
        </div>
    );
}
