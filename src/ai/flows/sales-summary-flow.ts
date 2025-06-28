'use server';
/**
 * @fileOverview Um fluxo de IA para analisar e resumir dados de vendas de um CSV.
 *
 * - summarizeSalesData - Uma função que recebe dados CSV e retorna uma análise gerada por IA.
 * - SalesSummaryInput - O tipo de entrada para a função summarizeSalesData.
 * - SalesSummaryOutput - O tipo de retorno para a função summarizeSalesData.
 */

import { ai } from '@/ai/genkit';
import { z } from 'zod';

const SalesSummaryInputSchema = z.object({
  csvData: z.string().describe('O conteúdo completo do arquivo CSV de dados de vendas.'),
  dateRange: z.string().describe('O período dos dados fornecidos (ex: "2024/01/01 - 2024/01/31").'),
});
export type SalesSummaryInput = z.infer<typeof SalesSummaryInputSchema>;

const SalesSummaryOutputSchema = z.object({
  summary: z.string().describe('Um resumo conciso e perspicaz dos dados de vendas em 2-4 frases, escrito em um tom amigável e encorajador. Deve ser uma visão geral de alto nível.'),
  highlights: z.array(z.string()).describe('Uma lista de 3-4 pontos destacando observações importantes, como melhores desempenhos, horários de pico ou tendências interessantes.'),
  recommendations: z.array(z.string()).describe('Uma lista de 2-3 recomendações acionáveis e específicas com base nos dados para ajudar a melhorar o desempenho de vendas.'),
});
export type SalesSummaryOutput = z.infer<typeof SalesSummaryOutputSchema>;

export async function summarizeSalesData(input: SalesSummaryInput): Promise<SalesSummaryOutput> {
  return salesSummaryFlow(input);
}

const prompt = ai.definePrompt({
  name: 'salesSummaryPrompt',
  input: { schema: SalesSummaryInputSchema },
  output: { schema: SalesSummaryOutputSchema },
  prompt: `Você é um analista de desempenho de vendas amigável e perspicaz para uma loja de varejo.
Sua tarefa é analisar um relatório diário de vendas fornecido em formato CSV e gerar um resumo com destaques e recomendações.
Os dados cobrem o período: {{{dateRange}}}.

Os dados CSV têm a seguinte estrutura:
- A primeira linha é o intervalo de datas.
- A segunda e a terceira linhas são cabeçalhos.
- As linhas subsequentes listam os vendedores e seu desempenho por hora.
- "At." significa "Atendimentos", que são interações diretas com o cliente ou vendas.
- "Pot." significa "Potenciais", que são oportunidades de vendas adicionais (por exemplo, uma pessoa acompanhando um cliente).

Analise os dados CSV fornecidos para identificar tendências, melhores desempenhos e áreas para melhoria.

Principais áreas para analisar:
1.  **Desempenho Geral**: Quais são os totais de atendimentos e potenciais?
2.  **Melhores Desempenhos**: Quem são os 3 melhores vendedores em termos de atendimentos? Quem é melhor em gerar potenciais?
3.  **Tendências Horárias**: Quais são os horários de pico para atendimentos de clientes? Existem períodos de calmaria?
4.  **Oportunidades**: Observe a proporção de potenciais para atendimentos. Um alto número de potenciais é um bom sinal de oportunidades de upsell.

Com base em sua análise, forneça um resumo conciso, alguns destaques principais e recomendações práticas. O tom deve ser profissional, mas encorajador.

Aqui estão os dados:
\`\`\`csv
{{{csvData}}}
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
    const { output } = await prompt(input);
    if (!output) {
        throw new Error("A IA não conseguiu gerar um resumo.");
    }
    return output;
  }
);
