#!/usr/bin/env python3
"""Exporta o catálogo de alimentos do Norish para um JSON que o cartão lê.

SPDX-License-Identifier: Apache-2.0
Copyright 2026 João Dionísio

Porque existe: o cartão corre no browser e não pode falar com o Norish (não há
CORS, e a chave da API não pode ficar no JavaScript). Este script põe o catálogo
num ficheiro que o Home Assistant serve na mesma origem — e aí o cartão lê-o sem
problema nenhum.

Atenção à licença dos dados: o catálogo vem da taxonomia de ingredientes do
Open Food Facts, distribuída sob a Open Database License (ODbL) v1.0. O
resultado deste script é um derivado dessa base de dados e, se o redistribuíres,
mantém a atribuição e a ODbL. Ele não faz parte deste repositório, que é
Apache-2.0.

É retomável e respeita o limite da chave (500 pedidos/hora, após os quais o
Norish *desativa* a chave e passa a responder 401, o que parece uma chave
inválida). Uma página = 50 alimentos = 1 pedido: um catálogo de 30 000 foods
precisa de ~600 pedidos, ou seja, duas passagens com folga.

    ./norish-catalogue-dump.py --status          # quanto falta?
    ./norish-catalogue-dump.py                   # uma passagem (orçamento 400)
    ./norish-catalogue-dump.py --max-calls 200   # mais conservador
    ./norish-catalogue-dump.py --build           # só reconstruir o JSON final

Ficheiros, todos ao lado do --out:
    norish-ingredients.parts.jsonl   bruto, uma página por linha (retomável)
    norish-ingredients.state.json    onde ficou (cursor) e se acabou
    norish-ingredients.json          o resultado final, que o cartão consome

O resultado final é uma lista simples de nomes (o português quando existe, mais
o inglês), que é uma das formas que o cartão aceita:

    ["cebola", "onion", "alho", "manteiga", "butter", ...]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Iterable, NoReturn

DEFAULT_SERVER = "https://norish.jdrdionisio.com"
KEY_FILE = "~/.config/norish/api_key"
PAGE_SIZE = 50  # o servidor decide; só o usamos para estimar
WARN_BUDGET = 450  # margem sob o limite de 500/h


def die(msg: str, code: int = 1) -> NoReturn:
    print(f"erro: {msg}", file=sys.stderr)
    raise SystemExit(code)


def read_key(path: str) -> str:
    p = os.path.expanduser(path)
    if not os.path.exists(p):
        die(f"não encontrei a chave em {p}\n"
            "      cria-a em Settings => User => API keys, no Norish, e grava-a aí:\n"
            "      mkdir -p ~/.config/norish && printf '%s' 'A_CHAVE' > ~/.config/norish/api_key\n"
            "      chmod 600 ~/.config/norish/api_key")
    key = open(p).read().strip()
    if not key:
        die(f"a chave em {p} está vazia")
    return key


def fetch_page(server: str, key: str, cursor):
    args = {} if cursor is None else {"cursor": cursor}
    inp = urllib.parse.quote(json.dumps({"0": {"json": args}}, separators=(",", ":")))
    url = f"{server}/api/trpc/ingredients.list?batch=1&input={inp}"
    req = urllib.request.Request(url, headers={"x-api-key": key, "User-Agent": "norish-dump"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 401:
            die("a chave foi recusada (401).\n"
                "      Quase sempre é o limite de 500 pedidos/hora: o Norish DESATIVA a chave\n"
                "      e responde 401 como se fosse inválida. Espera uma hora ou reativa-a em\n"
                "      Settings => User => API keys, e volta a correr com --max-calls menor.")
        die(f"HTTP {e.code} em {url}: {e.read()[:200]!r}")
    except (urllib.error.URLError, TimeoutError) as e:
        die(f"falha de rede: {e}")
    try:
        return payload[0]["result"]["data"]["json"]
    except (KeyError, IndexError, TypeError):
        die(f"resposta inesperada do servidor: {str(payload)[:300]}")


def load_state(path: str) -> dict:
    if os.path.exists(path):
        return json.load(open(path))
    return {"cursor": None, "done": False, "pages": 0, "items": 0}


def save_state(path: str, st: dict) -> None:
    tmp = path + ".tmp"
    json.dump(st, open(tmp, "w"))
    os.replace(tmp, path)


def progress(st: dict) -> str:
    return f"páginas {st['pages']} · registos {st['items']} · cursor {st['cursor']}"


#: Nomes que não servem para uma lista de compras: especificações industriais
#: da taxonomia ("50-63% unsalted vegetable fat…"), linhas só com dígitos ("1"),
#: percentagens. A taxonomia do Open Food Facts é um dicionário de fábrica, não
#: uma lista de cozinha.
_JUNK = re.compile(r"%|^\d|^[^\wÀ-ÿ]+$", re.UNICODE)

#: Variantes de preparação: "alho descascado e cortado em rodelas finas" descreve
#: o que se faz na cozinha, não o que se compra. Só se descartam quando o nome é
#: longo — "peito de frango sem pele" é curto e útil, e fica.
_PREP = re.compile(
    r"\b(cortad\w*|picad\w*|descascad\w*|fatiad\w*|ralad\w*|esmagad\w*|trilad\w*"
    r"|em rodelas|em cubos|em fatias|ao meio|finamente|grosseiramente"
    r"|cut into|finely|chopped|peeled|sliced|diced)\b",
    re.IGNORECASE,
)
PREP_MIN_LEN = 25


def is_junk(name: str) -> bool:
    if _JUNK.search(name):
        return True
    return len(name) >= PREP_MIN_LEN and bool(_PREP.search(name))


def collect_names(records: Iterable[dict], max_len: int | None, keep_junk: bool) -> set[str]:
    """Nomes úteis de cada registo: o `name` e os aliases em pt/pt-BR/en/sem-locale."""
    out: set[str] = set()
    for item in records:
        if not isinstance(item, dict):
            continue
        loc = item.get("localeNames") or {}
        candidates = [loc.get("pt"), loc.get("pt_PT"), item.get("name")]
        for a in item.get("aliases") or []:
            if not isinstance(a, dict):
                continue
            if a.get("locale") in (None, "pt", "pt-PT", "pt-BR", "en") and a.get("text"):
                candidates.append(a["text"])
        for c in candidates:
            if not c:
                continue
            name = str(c).strip()
            if not name:
                continue
            if max_len and len(name) > max_len:
                continue
            if not keep_junk and is_junk(name):
                continue
            out.add(name)
    return out


def write_names(out_path: str, names: set[str]) -> int:
    ordered = sorted(names, key=lambda s: s.casefold())
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(ordered, fh, ensure_ascii=False)
    os.replace(tmp, out_path)
    return len(ordered)


def build(parts_path: str, out_path: str, max_len: int | None, keep_junk: bool) -> int:
    """Constrói o JSON final a partir do bruto recolhido por páginas."""
    if not os.path.exists(parts_path):
        die("ainda não há páginas guardadas — corre primeiro sem --build")
    records: list[dict] = []
    with open(parts_path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.extend(json.loads(line))
    return write_names(out_path, collect_names(records, max_len, keep_junk))


def from_export(path: str, out_path: str, max_len: int | None, keep_junk: bool) -> int:
    """Converte um export do Norish ({source, ingredients:[…]}) no ficheiro do cartão.

    É o caminho para um export grande: 6200 alimentos com 71 000 aliases em duas
    dezenas de línguas dão 5,4 MB; só os nomes em português e inglês que servem
    para uma lista de compras dão uns 200 KB.
    """
    if not os.path.exists(path):
        die(f"não encontrei o export {path}")
    data = json.load(open(path, encoding="utf-8"))
    if isinstance(data, dict):
        records = data.get("ingredients") or data.get("items") or []
    elif isinstance(data, list):
        records = data
    else:
        die("o ficheiro não parece um export (esperava um objeto ou uma lista)")
    if not records:
        die("o export não trouxe alimentos")
    return write_names(out_path, collect_names(records, max_len, keep_junk))


def main() -> int:
    ap = argparse.ArgumentParser(description="Exporta o catálogo de alimentos do Norish.")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--key-file", default=KEY_FILE)
    ap.add_argument("--out", default="norish-ingredients.json")
    ap.add_argument("--max-calls", type=int, default=400,
                    help=f"orçamento de pedidos nesta passagem (limite do servidor: 500/h; "
                         f"não passes de {WARN_BUDGET})")
    ap.add_argument("--delay", type=float, default=0.15, help="pausa entre pedidos, em segundos")
    ap.add_argument("--status", action="store_true", help="só mostrar o progresso")
    ap.add_argument("--build", action="store_true", help="só reconstruir o JSON final")
    ap.add_argument("--from-export", metavar="FICHEIRO",
                    help="converter um export do Norish ({source, ingredients:[…]}) no ficheiro "
                         "do cartão — não toca na API")
    ap.add_argument("--max-name-length", type=int, default=45,
                    help="descartar nomes mais longos (a taxonomia tem descrições industriais muito "
                         "compridas); 0 para não descartar nenhum")
    ap.add_argument("--keep-junk", action="store_true",
                    help="não filtrar linhas só com dígitos nem percentagens")
    args = ap.parse_args()

    max_len = args.max_name_length or None

    if args.from_export:
        n = from_export(args.from_export, args.out, max_len, args.keep_junk)
        origem = os.path.getsize(args.from_export)
        final = os.path.getsize(args.out)
        print(f"{args.from_export}: {origem/1024/1024:.1f} MB")
        print(f"{args.out}: {n} nomes, {final/1024:.0f} KB "
              f"({origem/max(final,1):.0f}x mais pequeno)")
        print("\nAgora copia-o para o Home Assistant:")
        print(f"  cp {args.out} /config/www/{os.path.basename(args.out)}")
        print("e no cartão:")
        print(f"  ingredients_url: /local/{os.path.basename(args.out)}")
        return 0

    parts = args.out.replace(".json", "") + ".parts.jsonl"
    state_path = args.out.replace(".json", "") + ".state.json"
    st = load_state(state_path)

    if args.status:
        print(progress(st), "· terminado" if st["done"] else "· por terminar")
        if os.path.exists(args.out):
            print(f"ficheiro final: {args.out} ({os.path.getsize(args.out)} bytes)")
        return 0

    if args.build:
        n = build(parts, args.out, max_len, args.keep_junk)
        print(f"construído {args.out}: {n} nomes únicos")
        return 0

    if args.max_calls > WARN_BUDGET:
        die(f"--max-calls {args.max_calls} arrisca o limite de 500/hora; usa <= {WARN_BUDGET}")

    key = read_key(args.key_file)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    print(f"servidor {args.server}\n{progress(st)}")
    calls = 0
    cursor = st["cursor"] if not st["done"] else None

    if st["done"]:
        print("o catálogo já estava todo recolhido; a reconstruir o ficheiro final")
        n = build(parts, args.out, max_len, args.keep_junk)
        print(f"{args.out}: {n} nomes únicos")
        return 0

    with open(parts, "a", encoding="utf-8") as parts_fh:
        while calls < args.max_calls:
            page = fetch_page(args.server, key, cursor)
            items = page.get("items") or []
            calls += 1
            st["pages"] += 1
            st["items"] += len(items)
            parts_fh.write(json.dumps(items, ensure_ascii=False) + "\n")
            parts_fh.flush()

            next_cursor = page.get("nextCursor")
            if not items or next_cursor is None or next_cursor == cursor:
                st["done"] = True
                st["cursor"] = None
                save_state(state_path, st)
                print(f"\nfim do catálogo.\n{progress(st)} · pedidos nesta passagem: {calls}")
                break

            cursor = next_cursor
            st["cursor"] = cursor
            save_state(state_path, st)
            if calls % 25 == 0:
                print(f"  {progress(st)} · {calls}/{args.max_calls} nesta passagem")
            time.sleep(args.delay)

    if not st["done"]:
        save_state(state_path, st)
        print(f"\norçamento desta passagem esgotado.\n{progress(st)}")
        print("volta a correr dentro de uma hora, ou com outro --max-calls, para continuar:")
        print(f"  {os.path.basename(sys.argv[0])} --out {args.out}")

    n = build(parts, args.out, max_len, args.keep_junk)
    print(f"\n{args.out}: {n} nomes únicos")
    print("\nAgora copia o ficheiro para o Home Assistant:")
    print(f"  cp {args.out} /config/www/{os.path.basename(args.out)}")
    print("e no cartão:")
    print(f"  ingredients_url: /local/{os.path.basename(args.out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
