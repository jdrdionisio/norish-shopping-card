# Changelog

## Por publicar

- **README (secção de automações): generalizar o «não quero ser avisado das minhas
  próprias ações».** A nota atual diz para acrescentar um `condition` com
  `trigger.event.data.user_id != '<o teu id>'`. Isso não generaliza: o id é um
  UUID por instância (o YAML deixa de ser portátil) e o filtro exclui uma só
  pessoa (não escala para N utilizadores). Substituir por um mapa
  `user_id -> serviço de notify` e avisar todos **excepto** o autor —
  `{{ quem.items() | rejectattr('0', 'eq', autor) | map(attribute='1') | list }}`
  — que acrescenta pessoas sem tocar na automação. Explicar também que
  `trigger.event.data.user_id` é igual a `trigger.event.context.user_id` (comparar
  um com o outro é sempre verdadeiro) e que «eu» não existe numa automação: o
  autor da ação é o próprio contexto do trigger.

## v1.4.0

- **Eventos opcionais, com quem fez o quê.** Com `fire_events: true`, o cartão
  dispara `norish_shopping_card_changed` depois de cada ação, com `action`
  (`added`/`removed`/`completed`/`reopened`/`renamed`), `user_id`/`user_name`,
  `entity_id`/`store` e o item (`item`/`uid`, ou `items`/`uids` no «Limpar»).
  Desligado por omissão.
- Motivo: os triggers `todo.*` do core dizem **que** itens mudaram mas não **quem**
  — os dados de disparo não trazem o contexto do utilizador. O cartão corre com o
  `hass` do utilizador, por isso sabe-o.
- O evento herda o contexto do pedido, pelo que `trigger.event.context.user_id`
  também fica preenchido.
- Disparar eventos exige conta de administrador no HA (limitação do core): para
  quem não é admin o anúncio é ignorado com um aviso na consola.
- README com a secção de automações e o exemplo de YAML.

## v1.3.1

- **Licença mudada de MIT para Apache-2.0.** A Apache-2.0 mantém a permissividade
  e acrescenta uma concessão explícita de patentes; em troca pede que se preserve
  o `NOTICE` e se indique o que foi alterado.
- Novo ficheiro `NOTICE` com a atribuição do projeto.
- Cabeçalhos SPDX nos ficheiros de código, e nota no `scripts/norish-catalogue-dump.py`
  de que o catálogo que ele produz é um derivado do Open Food Facts e fica sob ODbL.

## v1.3.0

- **As sugestões funcionam sem configuração nenhuma.** Sem `ingredients_url`, o
  cartão procura o catálogo sozinho, por esta ordem: `/local/norish-ingredients.json`
  (o teu catálogo completo, no sítio habitual do HA) e depois
  `ingredientes-comuns.json`, que vem no repositório e é instalado com o cartão.
- Nova lista de **509 alimentos de mercearia em português** (`ingredientes-comuns.json`,
  7 KB), escrita de raiz e licenciada como o código — para uma instalação nova
  ter sugestões sem precisar de export nenhum do Norish.
- A descoberta automática falha em silêncio; só uma `ingredients_url` explícita
  mostra erro (com o URL que falhou).

## v1.2.1

- Nova opção `suggestions` (por omissão **10**, até 30) — quantas sugestões
  mostrar ao escrever.
- Quando o catálogo falha, a mensagem passa a dizer qual o URL que não foi
  possível carregar, para o diagnóstico ser imediato.
- Confirmado que o export bruto do Norish (5,4 MB) também funciona tal como
  está, sem conversão: 150 ms a carregar em vez de 30 ms.

## v1.2.0

- **Sugestões de alimentos ao escrever**: o cartão lê um catálogo JSON servido
  pelo Home Assistant (`ingredients_url`, ou `ingredients` no próprio YAML) e
  mostra chips com os alimentos que começam pelo texto escrito. Tocar num chip
  adiciona-o. Nada é bloqueado — qualquer nome novo continua a poder ser escrito
  e adicionado.
- Ranking com o exato primeiro, depois prefixo, depois palavra, e os nomes mais
  curtos antes dos longos; os itens já na lista não aparecem nas sugestões.
- Aceita várias formas de ficheiro: lista de nomes, lista de objetos
  (`name`/`localeNames`/`aliases`) e o export do Norish (`{source,
  ingredients:[…]}`).
- Script `scripts/norish-catalogue-dump.py`: vai buscar o catálogo à API
  (retomável, respeita o limite de 500 pedidos/hora) **ou** converte um export
  já existente. Um export real passou de 5,4 MB para 202 KB.
- `docs/ingredientes-exemplo.json` e captura das sugestões no README.

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
