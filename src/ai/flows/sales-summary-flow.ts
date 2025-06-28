
'use server';
/**
 * @fileOverview Um fluxo de IA para analisar e resumir dados de vendas e atendimentos de CSVs.
 *
 * - summarizeSalesData - Uma função que recebe dados CSV e retorna uma análise gerada por IA.
 * - SalesSummaryInput - O tipo de entrada para a função summarizeSalesData.
 * - SalesSummaryOutput - O tipo de retorno para a função summarizeSalesData.
 */

import { ai } from '@/ai/genkit';
import { z } from 'zod';

const SalesSummaryInputSchema = z.object({
  attendanceCsvData: z.string().describe('O conteúdo CSV dos dados de atendimentos e potenciais.'),
  salesCsvData: z.string().describe('O conteúdo CSV dos dados de vendas do PDV.'),
  dateRange: z.string().describe('O período dos dados fornecidos (ex: "2024/01/01 - 2024/01/31").'),
});
export type SalesSummaryInput = z.infer<typeof SalesSummaryInputSchema>;

const SalesSummaryOutputSchema = z.object({
  summary: z.string().describe('Um resumo conciso e perspicaz dos dados de vendas e atendimentos em 3-5 frases, escrito em um tom amigável e encorajador. Deve ser uma visão geral de alto nível.'),
  highlights: z.array(z.string()).describe('Uma lista de 3-4 pontos destacando observações importantes, como melhores desempenhos em conversão, receita, tendências ou discrepâncias interessantes entre atendimentos e vendas.'),
  recommendations: z.array(z.string()).describe('Uma lista de 2-3 recomendações acionáveis e específicas com base nos dados para ajudar a melhorar o desempenho geral. Ex: "Vendedor X tem alto volume de atendimento mas baixa conversão, sugerir treinamento de fechamento".'),
  individualHighlights: z.array(z.object({
    salesperson: z.string().describe('O nome do vendedor(a).'),
    highlight: z.string().describe('Um destaque conciso e perspicaz sobre o desempenho individual do vendedor(a), focando em seu ponto mais forte ou em uma área clara de melhoria.')
  })).describe('Uma lista de destaques individuais para cada vendedor(a) nos dados.')
});
export type SalesSummaryOutput = z.infer<typeof SalesSummaryOutputSchema>;

export async function summarizeSalesData(input: SalesSummaryInput): Promise<SalesSummaryOutput> {
  return salesSummaryFlow(input);
}

const prompt = ai.definePrompt({
  name: 'salesSummaryPrompt',
  input: { schema: SalesSummaryInputSchema },
  output: { schema: SalesSummaryOutputSchema },
  prompt: `Você é um analista de desempenho de vendas sênior, amigável e perspicaz para uma loja de varejo.
Sua tarefa é analisar e consolidar dois conjuntos de dados de desempenho de vendas, fornecidos em formato CSV, e gerar um resumo com destaques e recomendações práticas.
O período coberto pelos relatórios é: {{{dateRange}}}.

Você receberá dois arquivos:

1.  **Dados de Atendimento (CSV)**: Contém o registro de quantos clientes cada vendedor atendeu por hora.
    - "At." significa "Atendimentos", que são interações diretas com o cliente.
    - "Pot." significa "Potenciais", que são oportunidades de vendas adicionais (acompanhantes).

2.  **Dados de Vendas (CSV)**: Contém um resumo das vendas consolidadas por vendedor.
    - "Vendas" é o número de transações de venda realizadas.
    - "Total Vendas" é o valor monetário total das vendas (receita).
    - "PA" significa Peças por Atendimento, ou seja, a média de itens por transação.
    - "Bilhete Médio" é o valor médio por transação.

**Sua Análise Central deve focar em:**

1.  **Unificar os Dados**: Conecte os dados dos dois arquivos pelo nome do vendedor.
2.  **Calcular a Taxa de Conversão**: Esta é a métrica MAIS IMPORTANTE. Calcule-a para cada vendedor: (Número de Vendas / Total de Atendimentos). Uma conversão alta indica eficiência.
3.  **Analisar Desempenho Cruzado**:
    - Quem são os melhores vendedores em **Taxa de Conversão**?
    - Quem gera mais **Receita (Total Vendas)**?
    - Quem realiza mais **Atendimentos**? Existe correlação entre alto atendimento e alta conversão/receita?
    - Identifique discrepâncias: Vendedores com muitos atendimentos mas baixa conversão, ou vendedores com poucas vendas mas um Bilhete Médio muito alto.
    - **Taxa de Oportunidade**: Analise a proporção de Potenciais para Atendimentos. Vendedores que convertem potenciais agregam muito valor.

**Classificação de Desempenho (Taxa de Conversão):**
Use a tabela a seguir como referência para classificar o desempenho da taxa de conversão e para embasar suas recomendações.

| Categoria            | Faixa de Conversão (%) | Descrição                                                               |
| -------------------- | ---------------------- | ----------------------------------------------------------------------- |
| **Excelente**        | Acima de **70%**       | Vendedora com alta eficiência de vendas. Domina técnicas de fechamento. |
| **Bom**              | **65% a 70%**          | Boa taxa de conversão, acima da média. Há consistência.                 |
| **Regular**          | **60% a 64%**          | Conversão aceitável, mas com espaço para melhorar abordagem.            |
| **Baixo Desempenho** | Abaixo de **60%**      | Necessita treinamento e acompanhamento de perto.                        |

Com base nesta análise aprofundada, forneça um resumo conciso, destaques principais e recomendações que ajudem a direcionar treinamentos e estratégias de vendas.

**Para os Destaques Individuais, siga estas regras CRÍTICAS E OBRIGATÓRIAS para garantir 100% de precisão:**

1.  **PRECISÃO ACIMA DE TUDO. NÃO FAÇA AFIRMAÇÕES FALSAS.**
    -   Antes de declarar um vendedor(a) como "líder" ou "o(a) melhor" em qualquer métrica (Taxa de Conversão, Receita, Atendimentos, Ticket Médio, etc.), você **DEVE** comparar o valor dele(a) com o de **TODOS** os outros vendedores nos dados.
    -   A afirmação só pode ser feita se for **matematicamente e factualmente verdadeira**.
    -   **Exemplo de verificação:** Para dizer que "Carol tem a maior taxa de conversão", você precisa confirmar que a taxa dela é maior que a de todos os outros. Se não for, a afirmação é **FALSA** e não pode ser feita.

2.  **SEJA ESPECÍFICO E BASEADO EM DADOS.**
    -   Cada destaque deve se basear em uma métrica clara e em um valor numérico presente ou derivado dos dados.
    -   **Exemplo CORRETO (se for verdade):** "Carol se destaca como líder absoluta em taxa de conversão (93.1%), mostrando altíssima eficiência."
    -   **Exemplo CORRETO de oportunidade:** "A taxa de conversão de Adriana Felix (61.2%) é uma área clara para desenvolvimento, especialmente considerando seu alto volume de atendimentos."
    -   **Exemplo INCORRETO (generalização):** "Adriana Felix foi muito bem."

3.  **DESTAQUE ÚNICO E RELEVANTE PARA CADA VENDEDOR(A).**
    -   Crie exatamente um destaque para **CADA** vendedor(a) presente nos dados.
    -   Se um vendedor(a) não for o número 1 em nenhuma métrica principal, encontre seu ponto forte mais relevante (ex: "Possui o segundo maior Ticket Médio") ou aponte a oportunidade de melhoria mais impactante.
    -   Preencha o campo 'individualHighlights' com estes destaques.

Aqui estão os dados de ATENDIMENTO:
\`\`\`csv
{{{attendanceCsvData}}}
\`\`\`

Aqui estão os dados de VENDAS:
\`\`\`csv
{{{salesCsvData}}}
\`\`\`
`,
});

const salesSummaryFlow = ai.defineFlow(
  {
    name: 'salesSummaryFlow',
    inputSchema: SalesSummaryInputSchema,
    outputSchema: SalesSummaryOutputSchema,
  },
  async (input) => {
    // Se um dos CSVs estiver vazio, não podemos fazer a análise completa.
    if (!input.attendanceCsvData || !input.salesCsvData) {
      throw new Error("Dados de atendimento e vendas são necessários para a análise completa.");
    }
    const { output } = await prompt(input);
    if (!output) {
        throw new Error("A IA não conseguiu gerar um resumo.");
    }
    return output;
  }
);
