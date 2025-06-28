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

Com base nesta análise aprofundada, forneça um resumo conciso, destaques principais e recomendações que ajudem a direcionar treinamentos e estratégias de vendas.

**Além disso, para CADA vendedor(a) presente nos dados, crie um "Destaque Individual"**:
-   Para cada vendedor(a), escreva uma única frase que resuma seu principal ponto forte ou a oportunidade de melhoria mais evidente.
-   Exemplos: "Edilma se destaca na geração de receita, sendo a líder em vendas totais.", "A taxa de conversão de Pedrina é uma área de oportunidade, dado seu alto volume de atendimentos.", "Kemilly tem o maior ticket médio, mostrando foco em vendas de alto valor."
-   Preencha o campo 'individualHighlights' com esses destaques, um para cada vendedor.

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
