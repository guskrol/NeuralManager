# NeuraL Farm Control

Painel local para controlar uma farm de contas Jagex no DreamBot, com cadastro de contas, categorias, proxies, launch individual, launch em fila, logs, diagnostico e tasks continuas.

Versao atual: `0.2.53`

## Visao geral

O NeuraL Farm Control roda como um agent local no PC onde o DreamBot sera aberto. A interface web fica em `http://127.0.0.1:3000` e permite controlar as contas sem editar arquivos manualmente.

Principais funcionalidades:

- Cadastro individual e em massa de contas.
- Campo Notes por conta para registrar o que ela esta fazendo.
- Organizacao de contas por categoria.
- Cadastro e selecao de proxies por conta.
- Launch individual por conta.
- Launch por script ou por schedule do DreamBot.
- Launch em fila para contas habilitadas, com delay e contador regressivo.
- Deteccao de contas online com destaque visual.
- Saude por conta, com ultimo launch registrado.
- Consulta de stats OSRS por char name usando HiScores.
- Lista de processos atuais e historico de processos.
- Aba Processos dedicada para logs e controle de processos.
- Logs do launcher, stderr e DreamBot por processo.
- Continuous Tasks para relancar contas automaticamente por categoria.
- Diagnostico do setup.
- Aba Diagnóstico dedicada para avisos e erros de setup.
- Botao para encerrar o agent pelo painel.
- Versionamento visivel no topo do painel.

## Requisitos

- Windows.
- Node.js instalado e disponivel no terminal.
- DreamBot instalado.
- Caminho correto do `Launcher.jar` configurado na aba `Config`.
- Contas no formato `email:senha:TOTP_SECRET_BASE32`.

O terceiro campo da conta e a secret do autenticador, nao o codigo de 6 digitos. O painel gera o TOTP atual automaticamente quando precisa autenticar uma conta Jagex.

## Inicio rapido

Para controlar o DreamBot no mesmo PC:

```text
1-INICIAR-LOCAL.bat
```

Depois acesse:

```text
http://127.0.0.1:3000/
```

Para controlar o agent a partir de outro computador da mesma rede:

```text
2-INICIAR-REDE.bat
```

Depois acesse pelo navegador do outro computador:

```text
http://IP_DO_PC_DO_AGENT:3000/
```

Use o modo rede apenas em rede confiavel. O painel local nao deve ser exposto publicamente.

## Arquivos principais

- `server.mjs`: servidor local, API, controle de processos, login Jagex e loop continuous.
- `public/index.html`: estrutura da interface.
- `public/app.js`: comportamento do painel.
- `public/styles.css`: visual do painel.
- `VERSION`: versao exibida no topo da home.
- `data/accounts.txt`: contas reais.
- `data/farm.json`: configuracoes, contas cadastradas, categorias, proxies e tasks.
- `data/web-farm-state.json`: estado operacional, processos, logs e continuous.
- `data/logs/`: logs gerados por launches.
- `1-INICIAR-LOCAL.bat`: inicia o agent local.
- `2-INICIAR-REDE.bat`: inicia o agent aceitando conexoes na rede local.
- `tools/nick-capture-helper/dist/NeuraLNickCapture.jar`: script helper usado para capturar automaticamente o nick/char name da conta.

## Aba Config

A aba `Config` concentra as configuracoes globais:

- Caminho do `Launcher.jar` do DreamBot.
- Script padrao.
- World padrao.
- Maximo de instancias simultaneas.
- Delay entre launches.
- Opcoes de login Jagex/browser.

O caminho do `Launcher.jar` precisa apontar para o arquivo real do DreamBot no PC atual. Ao mover o projeto para outro computador, essa e a primeira configuracao que deve ser revisada.

## Aba Adicionar contas

Use essa aba para cadastrar contas novas.

Formato aceito:

```text
email:senha:TOTP_SECRET_BASE32
```

Voce pode adicionar uma conta individualmente ou usar o bulk import com varias linhas:

```text
email1:senha1:TOTP_SECRET_1
email2:senha2:TOTP_SECRET_2
email3:senha3:TOTP_SECRET_3
```

Ao adicionar a conta, escolha a categoria desejada. Essa categoria sera usada depois pelas tasks continuas e pelos filtros da farm.

Linhas invalidas e emails duplicados sao ignorados no import em massa.

## Aba Categorias

Categorias servem para separar grupos de contas por finalidade.

Exemplos:

- `Ranged40Para70`
- `tutorial`
- `mining`
- `woodcutting`
- `mules`
- `teste`

A categoria e usada em dois lugares importantes:

- Na aba `Contas`, cada conta pertence a uma categoria.
- Na aba `Continuous`, cada task puxa contas de uma categoria especifica.

Esse modelo evita misturar contas de teste com contas da farm principal.

## Aba Contas

A aba `Contas` e o painel principal de operacao.

Cada linha mostra:

- Checkbox para habilitar ou desabilitar a conta.
- Checkbox no cabecalho para habilitar ou desabilitar todas as contas de uma vez.
- Barra de acoes em massa para aplicar script, ARG e world ou excluir contas selecionadas.
- Email da conta.
- Char name para consulta de stats.
- Notes.
- Saude da conta.
- Categoria.
- Script.
- Schedule.
- ARG.
- World.
- Proxy.
- Botao de resumo/log.
- Botao de lixeira para excluir a conta.
- Botao `Salvar`.
- Botao `Launch`.

As configuracoes de notes, script, args, world, categoria e proxy ficam salvas por conta. Depois de editar uma linha, clique em `Salvar`.

Use `Notes` para identificar rapidamente o objetivo ou estado manual da conta, por exemplo `cozinhando`, `ranged 40-70`, `mule`, `teste proxy` ou `aguardando descanso`.

Use `Char name` para informar o nome do personagem no OSRS. O botao `Stats` busca os niveis no HiScores oficial, mostra um painel compacto com skills, total level e combat calculado, e guarda cache local por ate 30 minutos.

O campo `Schedule` e opcional. Quando ele estiver preenchido, o painel usa o QuickStart do DreamBot com `-schedule=<nome>` e ignora `Script`/`ARG` naquele launch. O nome precisa ser exatamente igual ao schedule salvo no DreamBot. Quando `Schedule` estiver vazio, o launch continua usando `-script` e `-params` normalmente.

Quando uma conta esta online, a linha ganha destaque verde. O painel detecta o processo real do DreamBot mesmo quando o launcher inicial fecha e o cliente Java fica rodando em outro PID.

A coluna `Saude` mostra o estado operacional da conta:

- `Online`: existe um processo DreamBot rodando para aquela conta.
- `Parada`: a conta ja foi lancada, mas nao ha processo rodando agora.
- `Atencao`: o ultimo estado/log conhecido indica erro ou falha.
- `Nunca ligada`: ainda nao existe launch registrado para aquela conta.

Essa coluna tambem mostra a ultima vez que a conta foi ligada, quando essa informacao existe.

### World

A coluna `World` aceita:

- `Fixo`: usa o numero informado no campo ao lado.
- `Random F2P`: deixa o DreamBot escolher um mundo F2P.
- `Random P2P`: deixa o DreamBot escolher um mundo members.

### Launch individual

O botao `Launch` abre apenas aquela conta, usando os dados salvos na linha.

O comando inclui:

- Script.
- World.
- ARG.
- Conta.
- Proxy, quando configurado.
- Login Jagex/browser quando habilitado.

Na aba `Config`, `Debug Jagex login` registra respostas relevantes do browser de login em `data/logs/jagex-debug-YYYY-MM-DD.log`. Use apenas para teste: o painel mascara campos sensiveis e tenta detectar candidatos a display name/char name.

### Lancar habilitadas

O botao `Lancar habilitadas` percorre as contas marcadas como habilitadas.

Ele respeita:

- Maximo de instancias simultaneas.
- Delay entre launches.
- Contas que ja estao rodando.
- Dados individuais de script, ARG, world e proxy.

Durante a fila, o painel mostra uma barra com contador regressivo e quantos launches ainda faltam. Quando nao ha fila ativa, essa barra fica escondida para nao ocupar espaco.

## Aba Proxy

Use a aba `Proxy` para cadastrar proxies e depois associa-los as contas.

Campos:

- Nome.
- Host.
- Porta.
- Usuario.
- Senha.

Bulk import aceito:

```text
nome:host:porta:usuario:senha
BR 01:1.2.3.4:8000:user:pass
BR 02:5.6.7.8:9000:user:pass
```

Quando uma conta tem proxy selecionado, o painel passa os parametros de proxy para o DreamBot no launch.

## Aba Continuous

Continuous e o piloto automatico controlado da farm.

Ele nao substitui o launch manual; ele observa o estado das contas e decide quando lancar novas instancias dentro dos limites definidos.

### Motor

Configuracoes gerais:

- Ativar ou pausar o loop.
- Intervalo de checagem.
- Stop all para parar processos rastreados.
- Logs de decisoes do loop.

### Tasks

Uma task continua define qual trabalho deve rodar em uma categoria de contas.

Campos principais:

- Nome da task.
- Categoria de contas.
- Script.
- Schedule.
- ARG.
- World.
- Modo de proxy.
- Max instancias.
- Delay entre launches.
- Cooldown por conta.
- Status ativa ou pausada.

Se a task tiver `Schedule` preenchido, o continuous usa o schedule do DreamBot para as contas daquela categoria. Se `Schedule` estiver vazio, usa `Script` e `ARG` como antes.

O loop faz o seguinte:

1. Le as tasks ativas.
2. Procura contas habilitadas na categoria da task.
3. Ignora contas que ja estao rodando.
4. Ignora contas em cooldown.
5. Respeita o limite de max instancias.
6. Lanca a proxima conta elegivel.
7. Registra a decisao no log.

### Botao Aplicar

O botao `Aplicar` copia os dados da task para as contas da categoria:

- Script.
- ARG.
- World.
- Proxy, dependendo do modo da task.

Use isso quando quiser preparar rapidamente todas as contas de uma categoria para rodar o mesmo setup manualmente ou pelo continuous.

## Login Jagex e TOTP

Para contas Jagex, o painel usa o fluxo de browser do DreamBot.

Fluxo esperado:

1. DreamBot abre o browser de login Jagex.
2. O painel espera a porta de debug ficar disponivel.
3. Preenche email.
4. Preenche senha.
5. Seleciona `Use your authenticator app`.
6. Gera o TOTP atual.
7. Preenche o codigo de 6 digitos.
8. O DreamBot continua o login.

Os logs dessa automacao aparecem no log do processo com o prefixo:

```text
[NeuraL Jagex Login]
```

Se o login travar, abra o resumo do processo e confira essas linhas primeiro.

## Captura automatica de nick

O painel consegue tentar preencher o nick/char name da conta automaticamente.

Para isso, o projeto inclui um script helper do DreamBot:

```text
tools/nick-capture-helper/dist/NeuraLNickCapture.jar
```

Quando voce inicia o painel pelos arquivos `.bat`, esse helper e copiado automaticamente para:

```text
%USERPROFILE%\DreamBot\Scripts\NeuraLNickCapture.jar
```

Esse arquivo aparece no DreamBot como:

```text
NeuraL Nick Capture
```

Fluxo esperado:

1. Se a conta ainda nao tiver nick salvo, o painel abre primeiro o helper `NeuraL Nick Capture`.
2. O helper espera a conta entrar no jogo.
3. Quando consegue ler o nome do personagem, ele grava uma linha de log com o nick.
4. O painel salva esse nick no `data/farm.json`.
5. Depois disso, o painel fecha/limpa o helper e abre o script ou schedule real da conta.

Depois que o nick ja esta salvo, o painel nao precisa rodar o helper novamente para aquela conta.

Se voce copiar o projeto para outro PC, mantenha a pasta `tools/nick-capture-helper/dist/` junto do projeto. Ao rodar o `.bat`, ele tenta sincronizar o helper novamente na pasta de scripts do DreamBot daquele computador.

Se o helper nao for encontrado, o launch ainda pode continuar, mas o painel registra no log que nao conseguiu instalar o helper de nick.

## Processos e logs

A area `Processos` mostra os launches rastreados.

Filtros:

- `Atuais`: mostra processos relevantes atuais.
- `Todos`: mostra historico.

Acoes:

- Abrir resumo/log.
- Parar processo.
- Parar todos.
- Limpar parados.
- Limpar tudo.

O resumo de um processo pode mostrar:

- Comando usado.
- Launcher stdout.
- Launcher stderr.
- Log do DreamBot associado.

Quando nenhum log novo do DreamBot e criado, o painel mostra essa informacao. Isso geralmente indica que o launcher fechou antes do cliente abrir.

## Diagnostico

O bloco `Diagnostico` ajuda a encontrar problemas de setup.

Ele pode avisar sobre:

- Caminho do `Launcher.jar` invalido.
- Maximo de instancias maior que a quantidade de contas habilitadas.
- Task ativa sem contas habilitadas na categoria.
- Script ainda marcado como teste.
- Proxy ausente ou inconsistente.

Use `Revalidar` depois de alterar configuracoes.

## Encerrar agent

O botao `Encerrar agent` finaliza o servidor local pelo painel.

Isso e util quando:

- Voce fechou o CMD, mas a porta `3000` continuou em uso.
- O painel continua abrindo no navegador mesmo sem janela do terminal visivel.
- Voce quer reiniciar limpo pelo `.bat`.

Se a porta continuar ocupada, os `.bat` tambem tentam detectar o processo e perguntar se voce quer encerra-lo.

## Versionamento

A versao do painel fica em `VERSION` e aparece no topo da home.

Regra do projeto:

- Toda alteracao no painel, backend, comportamento ou documentacao deve incrementar a versao.

Isso ajuda a confirmar se o PC atual esta rodando a versao correta depois de copiar arquivos para outra maquina.

## Migrar para outro PC

Passos recomendados:

1. Copie a pasta do projeto.
2. Abra o painel pelo `.bat`.
3. Va em `Config`.
4. Ajuste o caminho do `Launcher.jar`.
5. Confira se `data/accounts.txt` e `data/farm.json` foram copiados.
6. Confira a versao no topo do painel.
7. Teste uma conta individual antes de usar `Lancar habilitadas`.

Arquivos mais importantes para preservar:

- `data/accounts.txt`
- `data/farm.json`
- `data/web-farm-state.json`

Esses arquivos contem suas contas, categorias, proxies, tasks e estado da farm.

## Solucao de problemas

### Porta 3000 em uso

Isso acontece quando o servidor Node continua rodando em segundo plano.

Solucoes:

- Use o botao `Encerrar agent`.
- Rode o `.bat` novamente e aceite encerrar o processo quando ele perguntar.
- Se necessario, encerre o processo Node pelo Gerenciador de Tarefas.

### Painel funciona mesmo sem CMD aberto

O processo Node ficou vivo em segundo plano. Isso e normal quando a janela foi fechada sem encerrar o processo corretamente.

Use `Encerrar agent` para finalizar.

### DreamBot pisca e fecha

Abra o resumo do processo e confira:

- `Launcher stdout`
- `Launcher stderr`
- `DreamBot log`

Se nao houver log novo do DreamBot, o launcher provavelmente fechou antes de abrir o cliente.

### Login Jagex travou

Abra o log do processo e procure por:

```text
[NeuraL Jagex Login]
```

Veja em qual etapa parou: email, senha, selecao do autenticador ou TOTP.

### Conta online sem destaque verde

O painel tenta reconciliar o processo do launcher com o processo real do DreamBot. Use `Revalidar` ou atualize a pagina. Se ainda nao aparecer, confira se o processo Java do DreamBot esta ativo.

### `Cannot read properties of undefined (reading 'index')`

Esse erro ocorria ao usar `Lancar habilitadas` em versoes antigas quando a fila tentava acessar uma conta inexistente.

Confirme se o topo do painel mostra uma versao atual e se os arquivos `server.mjs` e `public/app.js` foram copiados para o outro PC.

### Console Java poluindo a tela

O painel usa launch oculto/covert para evitar abrir consoles desnecessarios. Se janelas continuarem aparecendo, confira se o outro PC esta com a versao correta do painel.

## Seguranca

Os arquivos em `data/` podem conter emails, senhas, secrets TOTP e proxies.

Cuidados:

- Nao publique a pasta `data/`.
- Nao compartilhe prints com secrets visiveis.
- Use o modo rede apenas em LAN confiavel.
- Antes de expor fora da rede local, implemente autenticacao.
