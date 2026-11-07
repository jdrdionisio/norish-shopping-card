# Changelog

## v1.1.0

- **Aviso de duplicados**: enquanto escreves, o cartão mostra os itens que já
  correspondem ao texto — em qualquer loja, com distinção entre por comprar e
  já comprado — e, se configurares `pantry_entity`, os que já tens na despensa.
- Comparação tolerante: ignora maiúsculas/acentos, descarta quantidade e
  unidade no início (`2 kg batatas` = `batatas`) e aceita singular/plural
  (`ovo` encontra `Ovos`).
- Nova opção `warn_duplicates` (por omissão `true`) e `pantry_entity`.
- `docs/pantry-opcional.yaml`: sensor REST, com URL testado, para trazer a
  despensa do Norish para o Home Assistant.
- `docs/como-funciona.html` atualizado com a secção de duplicados.

## v1.0.0

Primeira versão.

- Cartão Lovelace `norish-shopping-card` sobre as entidades `todo.norish_*` da
  integração [hass-norish](https://github.com/Caps3n/hass-norish).
- Seletor de loja (Unsorted + uma por loja) com contagem de itens ativos.
- Adicionar item (Enter), marcar/desmarcar feita, editar o texto inline
  (tocar no item), apagar item, limpar todas as feitas.
- Atualização em tempo real por subscrição websocket (`todo/item/subscribe`).
- Só texto, sem imagens.
