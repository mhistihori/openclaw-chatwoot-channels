import { appendFileSync, closeSync, openSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
/** Largest part of a state file that is read back on start. Older lines are ignored. */
export const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
/**
 * Lines of a JSONL state file, reading at most `maxBytes` from the end. A file larger than that
 * (for example after a flood, or a bug in an older version) is never loaded whole; the oldest
 * lines are dropped, together with the partial line the cut may have produced.
 */
export function readTailLines(file, maxBytes = DEFAULT_MAX_READ_BYTES) {
    let size;
    try {
        size = statSync(file).size;
    }
    catch {
        return [];
    }
    if (size === 0)
        return [];
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
        let read = 0;
        while (read < length) {
            const n = readSync(fd, buf, read, length - read, size - length + read);
            if (n === 0)
                break;
            read += n;
        }
    }
    finally {
        closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n");
    if (size > length)
        lines.shift(); // the first line was cut in the middle
    return lines.filter((l) => l !== "");
}
/** Replace the file with `lines` in one step, so a crash leaves either the old or the new file. */
export function writeLinesAtomic(file, lines) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    renameSync(tmp, file);
}
/**
 * An append-only log with a bound. It counts what it has written and asks the owner to
 * rewrite it (`compact`) once it passes `maxLines` or `maxBytes`. A failing disk (full, read
 * only) never throws into the webhook path: it is reported once and the owner keeps working
 * from memory.
 */
export function createBoundedLog(opts) {
    let lines = opts.initialLines ?? 0;
    let bytes = opts.initialBytes ?? 0;
    let reported = false;
    const fail = (what, e) => {
        if (reported)
            return;
        reported = true;
        opts.onError?.(`${what} (${opts.file}): ${String(e)}; continuing from memory only`);
    };
    function compactNow() {
        try {
            const kept = opts.compact();
            writeLinesAtomic(opts.file, kept);
            lines = kept.length;
            bytes = kept.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
        }
        catch (e) {
            fail("could not compact state file", e);
        }
    }
    return {
        append(line) {
            try {
                appendFileSync(opts.file, `${line}\n`);
            }
            catch (e) {
                fail("could not write state file", e);
                return;
            }
            lines++;
            bytes += Buffer.byteLength(line) + 1;
            if (lines > opts.maxLines || bytes > opts.maxBytes)
                compactNow();
        },
        compactNow,
    };
}
