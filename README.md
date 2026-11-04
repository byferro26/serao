# Serão — publicar no Railway

App de gestão de eventos + website público, num só serviço Node.

- **Website** em `/` — qualquer pessoa pode pedir orçamento; o pedido chega a *Pedidos*.
- **Área de staff** no botão *Staff* — login com palavra-passe verificada no servidor.
- **Dados** numa base de dados Postgres do Railway (clientes, eventos, fornecedores, pedidos, chat, ficheiros).
- **Começa vazio**, sem dados de exemplo.

## Utilizadores iniciais

| Utilizador | Palavra-passe |
|---|---|
| Admin | 1234 |
| IT | 1234 |

**Muda-as logo no primeiro acesso:** entra como IT → *Sistema e equipa*. A palavra-passe tem de ter pelo menos 4 algarismos (só números).

## Publicar (pelo site do Railway, sem instalar nada)

1. Cria um repositório no GitHub (por exemplo `serao`) e carrega para lá **todos os ficheiros desta pasta** (Add file → Upload files). Não carregues a pasta `node_modules`.
2. Em [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → escolhe o repositório.
3. No mesmo projeto: **+ Create → Database → PostgreSQL**.
4. Abre o serviço da app → **Variables** e adiciona:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (usa "Add Reference" e escolhe a do Postgres)
   - `SESSION_SECRET` = uma frase longa e aleatória (ex.: 40 letras e números ao calhas)
   - `ANTHROPIC_API_KEY` = a tua chave da API da Anthropic (opcional — sem ela, os botões de IA não aparecem)
5. **Settings → Networking → Generate Domain** para teres o endereço público (ex.: `serao.up.railway.app`). Mais tarde podes ligar um domínio teu (ex.: `serao.pt`) em *Custom Domain*.

O Railway deteta o Node sozinho e corre `npm start`.

## Publicar pela linha de comandos (alternativa)

```bash
npm i -g @railway/cli
railway login
railway init                 # cria o projeto
railway add -d postgres      # cria a base de dados
railway up                   # envia esta pasta
```
Depois define as variáveis do passo 4 no painel do Railway e gera o domínio.

## Variáveis

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Base de dados Postgres (obrigatória em produção) |
| `SESSION_SECRET` | Assina as sessões. Sem ela, toda a gente sai da conta quando o servidor reinicia |
| `ANTHROPIC_API_KEY` | Liga a IA (preencher formulários, assistente, resposta a pedidos) |
| `ANTHROPIC_MODEL` | Opcional. Por defeito `claude-sonnet-5-5` |

## Testar no teu computador

```bash
npm install
npm start          # abre http://localhost:3000
```
Sem `DATABASE_URL`, os dados ficam na pasta `data/` (só para testes).

## Cópias de segurança

Na app: IT → *Sistema e equipa* → **Exportar dados (.json)**. O Railway também faz backups do Postgres (separador *Backups* da base de dados, nos planos pagos).
