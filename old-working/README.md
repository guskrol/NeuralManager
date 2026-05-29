# NeuraL Farm Control

Ferramentas locais para lançar contas Jagex no DreamBot usando o formato `email:senha:totp_secret`.

## Arquivos

- `accounts.txt`: suas contas reais, uma por linha.
- `launch-dreambot.ps1`: teste simples com uma conta.
- `farm-launcher.ps1`: gerenciador v1 para varias contas.
- `farm.json`: configuracao da farm.
- `farm.example.json`: exemplo limpo de configuracao.

## 1. Contas

No `accounts.txt`, use uma conta por linha:

```text
email:senha:TOTP_SECRET_BASE32
```

O terceiro campo e a secret do autenticador, nao o codigo de 6 digitos.

## 2. Teste simples com uma conta

Conferir TOTP sem abrir DreamBot:

```powershell
powershell -ExecutionPolicy Bypass -File .\launch-dreambot.ps1 -ScriptName "NOME_DO_SCRIPT" -ShowTotp
```

Compare o código exibido com o site/app que você usa hoje. Se bater, a geração local está correta.

Abrir DreamBot passando a secret:

```powershell
powershell -ExecutionPolicy Bypass -File .\launch-dreambot.ps1 -ScriptName "NOME_DO_SCRIPT" -World 301 -Launch
```

Abrir DreamBot passando o codigo de 6 digitos gerado na hora:

```powershell
powershell -ExecutionPolicy Bypass -File .\launch-dreambot.ps1 -ScriptName "NOME_DO_SCRIPT" -World 301 -UseGeneratedTotp -Launch
```

## 3. Gerenciador v1

Editar `farm.json`:

```json
{
  "defaultScriptName": "Teste",
  "defaultWorld": 301,
  "launchDelaySeconds": 20,
  "maxInstances": 2,
  "accounts": [
    {
      "index": 0,
      "enabled": true,
      "scriptName": "Teste",
      "world": 301,
      "scriptParams": []
    }
  ]
}
```

`index` e a linha da conta no `accounts.txt`, comecando em `0`.

Ver preview sem abrir DreamBot:

```powershell
powershell -ExecutionPolicy Bypass -File .\farm-launcher.ps1 -Action Preview
```

Lancar as contas habilitadas:

```powershell
powershell -ExecutionPolicy Bypass -File .\farm-launcher.ps1 -Action Launch
```

Ver processos lancados pelo gerenciador:

```powershell
powershell -ExecutionPolicy Bypass -File .\farm-launcher.ps1 -Action Status
```

Parar processos rastreados:

```powershell
powershell -ExecutionPolicy Bypass -File .\farm-launcher.ps1 -Action Stop
```

## 4. Painel web local

Jeito mais facil no Windows:

```text
1-INICIAR-LOCAL.bat
```

Use quando for controlar e abrir o DreamBot no mesmo PC. Esse arquivo checa se o Node.js existe, cria `accounts.txt` se estiver faltando, cria `farm.json` a partir do exemplo se necessario e inicia o painel.

Iniciar o NeuraL Farm Control:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-web.ps1
```

Mantenha essa janela aberta e acesse:

```text
http://127.0.0.1:3000/
```

O painel permite editar configuracao, adicionar contas, salvar script/world por conta, lancar uma conta, lancar as habilitadas e parar processos rastreados.

Na coluna `World`, use `Fixo` para escolher um world numerico, ou `Random F2P` / `Random P2P` para deixar o DreamBot escolher um world gratuito ou members via QuickStart.

Na aba `Proxy`, cadastre proxies em SOCKS com nome, host, porta, usuario e senha. Depois, na aba `Contas`, escolha o proxy de cada conta na coluna `Proxy` e clique em `Salvar`. No launch, o painel passa `-proxyHost`, `-proxyPort`, `-proxyUser` e `-proxyPass` para o DreamBot quando a conta tem proxy selecionado.

Bulk import de proxy aceita:

```text
nome:host:porta:usuario:senha
BR 01:1.2.3.4:8000:user:pass
BR 02:5.6.7.8:9000:user:pass
```

No painel, use `Bulk import` para colar varias contas de uma vez:

```text
email1:senha1:TOTP_SECRET_1
email2:senha2:TOTP_SECRET_2
email3:senha3:TOTP_SECRET_3
```

Linhas invalidas e emails duplicados sao ignorados e exibidos no resultado do import.

Para testar de outro computador na mesma rede, inicie o agent assim:

```text
2-INICIAR-REDE.bat
```

Use no PC onde o DreamBot vai abrir. Depois acesse esse PC pelo navegador de outro computador na mesma rede.

Ou manualmente:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-web.ps1 -BindHost 0.0.0.0
```

No outro computador, acesse:

```text
http://IP_DO_PC_DO_AGENT:3000/
```

Use apenas em rede confiavel por enquanto. A proxima etapa antes de expor fora da sua rede e colocar senha/token.

## Observação

Os scripts mascaram senha e secret no preview. Nao coloque `accounts.txt` em repositorio publico.
