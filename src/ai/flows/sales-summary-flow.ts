'use server';
/**
 * @fileOverview An AI flow for analyzing and summarizing sales data from a CSV.
 *
 * - summarizeSalesData - A function that takes CSV data and returns an AI-generated analysis.
 * - SalesSummaryInput - The input type for the summarizeSalesData function.
 * - SalesSummaryOutput - The return type for the summarizeSalesData function.
 */

import { ai } from '@/ai/genkit';
import { z } from 'zod';

const SalesSummaryInputSchema = z.object({
  csvData: z.string().describe('The full content of the sales data CSV file.'),
  dateRange: z.string().describe('The date range for the provided data (e.g., "2024/01/01 - 2024/01/31").'),
});
export type SalesSummaryInput = z.infer<typeof SalesSummaryInputSchema>;

const SalesSummaryOutputSchema = z.object({
  summary: z.string().describe('A concise, insightful summary of the sales data in 2-4 sentences, written in a friendly and encouraging tone. This should be a high-level overview.'),
  highlights: z.array(z.string()).describe('A list of 3-4 bullet points highlighting key observations, such as top performers, peak hours, or interesting trends.'),
  recommendations: z.array(z.string()).describe('A list of 2-3 actionable and specific recommendations based on the data to help improve sales performance.'),
});
export type SalesSummaryOutput = z.infer<typeof SalesSummaryOutputSchema>;

export async function summarizeSalesData(input: SalesSummaryInput): Promise<SalesSummaryOutput> {
  return salesSummaryFlow(input);
}

const prompt = ai.definePrompt({
  name: 'salesSummaryPrompt',
  input: { schema: SalesSummaryInputSchema },
  output: { schema: SalesSummaryOutputSchema },
  prompt: `You are a friendly and sharp-witted sales performance analyst for a retail store.
Your task is to analyze a daily sales report provided in a CSV format and generate a summary with highlights and recommendations.
The data covers the period: {{{dateRange}}}.

The CSV data has the following structure:
- The first row is the date range.
- The second and third rows are headers.
- Subsequent rows list salespeople and their performance per hour.
- "At." stands for "Atendimentos" (Attendances/Services), which are direct customer interactions or sales.
- "Pot." stands for "Potenciais" (Potentials), which are opportunities for additional sales (e.g., a person accompanying a customer).

Analyze the provided CSV data to identify trends, top performers, and areas for improvement.

Key areas to analyze:
1.  **Overall Performance**: What are the total attendances and potentials?
2.  **Top Performers**: Who are the top 3 salespeople in terms of attendances? Who is best at generating potentials?
3.  **Hourly Trends**: What are the peak hours for customer attendances? Are there any quiet periods?
4.  **Opportunities**: Look at the ratio of potentials to attendances. A high number of potentials is a good sign of upselling opportunities.

Based on your analysis, provide a concise summary, a few key highlights, and actionable recommendations. The tone should be professional yet encouraging.

Here is the data:
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
        throw new Error("AI failed to generate a summary.");
    }
    return output;
  }
);
