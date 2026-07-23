# Backend de pagamentos — Solo Fitness

Este servidor mantém **MERCADO_PAGO_ACCESS_TOKEN**, credenciais do Firebase Admin e acesso à Google Play Developer API fora do APK.

## Implantação

1. Use Node.js 20 ou superior.
2. Instale: `npm install`.
3. Configure as variáveis de `.env.example` como **segredos** do seu provedor.
4. Ative a Google Play Android Developer API no projeto Google Cloud e dê à conta de serviço acesso financeiro ao app na Play Console.
5. Em **Suas integrações > Webhooks**, cadastre `https://SEU_BACKEND/api/mercado-pago/webhook`, selecione o evento **Pagamentos** e salve a assinatura em `MERCADO_PAGO_WEBHOOK_SECRET`.
6. Inicie: `npm start`.
7. No painel ADM do app, abra **PAGAMENTOS DA LOJA** e informe a mesma URL HTTPS em `backend_url`.

## Rotas

- `POST /api/google-play/verify`: valida o token pela Android Publisher API e credita uma única vez.
- `POST /api/mercado-pago/preference`: cria uma preferência Checkout Pro para o usuário autenticado.
- `POST /api/mercado-pago/webhook`: confirma o pagamento consultando a API do Mercado Pago e credita uma única vez.
- `GET /health`: teste de disponibilidade.

## Segurança

O cliente envia `Authorization: Bearer <Firebase ID token>`. Preços e quantidades são lidos do catálogo fixo no servidor; valores enviados pelo APK são ignorados. O webhook valida `x-signature`, consulta o pagamento pela API oficial e o crédito é idempotente por token/pedido.

Para produção, mantenha a opção Mercado Pago desativada em builds distribuídos pela Google Play, salvo quando sua conta e região estiverem inscritas em um programa de faturamento alternativo aplicável.
