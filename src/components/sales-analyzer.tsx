
"use client";

import { useState, useMemo, useCallback, useRef } from 'react';
import type { DateRange } from "react-day-picker";
import { format } from "date-fns";
import { ptBR } from 'date-fns/locale';
import { parse as parseDate, isWithinInterval, startOfDay, endOfDay } from 'date-fns';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

import { summarizeSalesData, type SalesSummaryOutput } from '@/ai/flows/sales-summary-flow';
import { useToast } from "@/hooks/use-toast";
import { 
    UploadCloud, BarChart as BarChartIcon, Users, Target, Calendar as CalendarIcon, X, Loader2, Sparkles, 
    TrendingUp, CheckCircle, DollarSign, HelpCircle, FileDown, ArrowUp, ArrowDown, ArrowUpDown, File, Folder, Lightbulb, Trophy
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";

// Tipos para dados de Atendimento
type HourlyData = {
  hour: number;
  attendances: number;
  potentials: number;
};

type SalespersonPerformance = {
  salesperson: string;
  hourly: HourlyData[];
  totalAttendances: number;
  totalPotentials: number;
};

type LoadedAttendanceFile = {
    name: string;
    content: string;
    dateRange: { start: Date; end: Date };
    parsedData: SalespersonPerformance[];
};

// Tipos para dados de Vendas (PDV)
type SalespersonSales = {
  salesperson: string;
  salesCount: number;
  totalRevenue: number;
  averageTicket: number;
  itemsPerSale: number;
};

type LoadedSalesFile = {
    name: string;
    content: string;
    parsedData: SalespersonSales[];
};

// Tipo para dados consolidados
type ConsolidatedData = SalespersonPerformance & SalespersonSales & {
    conversionRate: number;
};

const cleanSalespersonName = (name: string): string => {
    if (!name) return '';
    return name
        .replace(/^\d+-\d+\s+/, '') // Remove prefix like "1-7 "
        .replace(/\s*\([^)]+\)$/, '') // Remove suffix like " (FUNCIONARIO)"
        .trim();
};

const parseDateRangeFromString = (rangeStr: string): { start: Date, end: Date } | null => {
    const tryParseDate = (dateString: string): Date | null => {
        const formats = ['dd/MM/yyyy', 'yyyy/MM/dd', 'dd-MM-yyyy', 'yyyy-MM-dd', 'd/M/yy', 'd/M/yyyy'];
        for (const format of formats) {
            const date = parseDate(dateString.trim(), format, new Date());
            if (!isNaN(date.getTime()) && date.getFullYear() > 1970) {
                return date;
            }
        }
        return null;
    };

    const rangeRegex = /(\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4})[^0-9]+(\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4})/;
    const match = rangeStr.match(rangeRegex);

    if (match && match.length === 3) {
        const startDate = tryParseDate(match[1]);
        const endDate = tryParseDate(match[2]);

        if (startDate && endDate) {
            return {
                start: startOfDay(startDate < endDate ? startDate : endDate),
                end: endOfDay(startDate < endDate ? endDate : startDate),
            };
        }
    }

    const parts = rangeStr.split('-').map(p => p.trim());
    if (parts.length === 2) {
        const startDate = tryParseDate(parts[0]);
        const endDate = tryParseDate(parts[1]);
        if (startDate && endDate) {
            return { start: startOfDay(startDate), end: endOfDay(endDate) };
        }
    }
    
    return null;
};

const parseAttendanceCsv = (csvText: string): { data: SalespersonPerformance[], dateRange: { start: Date, end: Date } } => {
    const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 4) throw new Error("Formato de arquivo de atendimento inválido. O arquivo parece estar incompleto.");

    const dateRange = parseDateRangeFromString(lines[0]);
    if (!dateRange) {
        const header = lines[0].toLowerCase();
        if (header.includes('vendedor') && (header.includes('total vendas') || header.includes('vendas'))) {
            throw new Error("Arquivo incorreto. Você carregou um arquivo de Vendas na área de Atendimento. Por favor, use a área de upload correspondente.");
        }
        throw new Error("Não foi possível encontrar um período de datas válido na primeira linha do arquivo de atendimento. Verifique o arquivo.");
    }
    
    const rawHourHeaders = lines[1].split(';');
    let lastHourHeader = '';
    const hourHeaders = rawHourHeaders.map(h => {
        const trimmed = h.trim();
        if (trimmed) { lastHourHeader = trimmed; return trimmed; }
        return lastHourHeader;
    });
    const metricHeaders = lines[2].split(';').map(h => h.trim().toLowerCase());
    if (!metricHeaders[0].startsWith('vendedor')) throw new Error("Cabeçalho de Vendedor não encontrado no arquivo de atendimento.");
    
    const columns: Array<{ hour: number, type: 'attendances' | 'potentials' } | null> = [];
    for (let i = 1; i < hourHeaders.length; i++) {
        const hourHeader = hourHeaders[i];
        const metricHeader = metricHeaders[i];
        if (hourHeader.toLowerCase().includes('total')) { columns.push(null); continue; }
        const hourMatch = hourHeader.match(/(\d{1,2})h/);
        if (!hourMatch) { columns.push(null); continue; }
        const hour = parseInt(hourMatch[1], 10);
        if (metricHeader === 'at.') columns.push({ hour, type: 'attendances' });
        else if (metricHeader === 'pot.') columns.push({ hour, type: 'potentials' });
        else columns.push(null);
    }
    
    const dataRows = lines.slice(3);
    const parsedData: SalespersonPerformance[] = [];
    for (const row of dataRows) {
        const values = row.split(';').map(v => v.trim());
        const rawSalesperson = values[0];
        if (!rawSalesperson) continue;
        const lowerRawSalesperson = rawSalesperson.toLowerCase();
        if (lowerRawSalesperson.includes('total') || lowerRawSalesperson.includes('nara') || lowerRawSalesperson.includes('vendedor') || lowerRawSalesperson.startsWith('data')) continue;
        const salesperson = cleanSalespersonName(rawSalesperson);
        if (!salesperson) continue;
        const hourlyMap = new Map<number, { attendances: number, potentials: number }>();
        for(let i = 1; i < values.length; i++) {
            if (i > columns.length) continue;
            const columnInfo = columns[i-1];
            if (!columnInfo || !values[i]) continue;
            const value = parseInt(values[i], 10);
            if (isNaN(value)) continue;
            const { hour, type } = columnInfo;
            const current = hourlyMap.get(hour) || { attendances: 0, potentials: 0 };
            current[type] += value;
            hourlyMap.set(hour, current);
        }
        const hourly = Array.from(hourlyMap.entries()).map(([hour, data]) => ({ hour, ...data })).sort((a,b) => a.hour - b.hour);
        const totalAttendances = hourly.reduce((sum, h) => sum + h.attendances, 0);
        const totalPotentials = hourly.reduce((sum, h) => sum + h.potentials, 0);
        parsedData.push({ salesperson, hourly, totalAttendances, totalPotentials });
    }
    if (parsedData.length === 0) throw new Error("Nenhum dado de atendimento válido foi encontrado no arquivo.");
    return { data: parsedData, dateRange };
};

const parseSalesCsv = (csvText: string): SalespersonSales[] => {
    const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error("Formato de arquivo de vendas inválido. O arquivo parece estar incompleto.");

    const firstLine = lines[0].toLowerCase();
    const hasDate = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(firstLine);
    if (hasDate && !firstLine.includes('vendedor')) {
        throw new Error("Arquivo incorreto. Você carregou um arquivo de Atendimento na área de Vendas. Por favor, use a área de upload correspondente.");
    }
    
    const dataRows = lines.slice(1);
    const parseCurrency = (str: string) => parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
    const parseIntSimple = (str: string) => parseInt(str, 10) || 0;
    const parseFloatSimple = (str: string) => parseFloat(str.replace(',', '.')) || 0;
    
    const parsedData: SalespersonSales[] = [];
    for (const row of dataRows) {
        const values = row.split(';').map(v => v.trim());
        if (values.length < 11) continue;
        const rawSalespersonName = values[0];
        if (!rawSalespersonName) continue;
        const lowerRawSalesperson = rawSalespersonName.toLowerCase();
        if (lowerRawSalesperson.includes('total') || lowerRawSalesperson.includes('nara') || lowerRawSalesperson.includes('vendedor') || lowerRawSalesperson.startsWith('data')) continue;
        const salesperson = cleanSalespersonName(rawSalespersonName);
        if (!salesperson) continue;

        parsedData.push({
            salesperson,
            salesCount: parseIntSimple(values[2]),
            itemsPerSale: parseFloatSimple(values[6]),
            totalRevenue: parseCurrency(values[8]),
            averageTicket: parseCurrency(values[10]),
        });
    }
    if (parsedData.length === 0) throw new Error("Nenhum dado de vendas válido foi encontrado no arquivo.");
    return parsedData;
};

const mergeAttendanceData = (datasets: SalespersonPerformance[][]): SalespersonPerformance[] => {
    const mergedMap = new Map<string, SalespersonPerformance>();
    for (const dataset of datasets) {
        for (const newPerson of dataset) {
            let existingPerson = mergedMap.get(newPerson.salesperson);
            if (!existingPerson) {
                existingPerson = { salesperson: newPerson.salesperson, hourly: [], totalAttendances: 0, totalPotentials: 0 };
                mergedMap.set(newPerson.salesperson, existingPerson);
            }
            const hourlyMap = new Map<number, HourlyData>(existingPerson.hourly.map(h => [h.hour, {...h}]));
            for (const newHour of newPerson.hourly) {
                const existingHour = hourlyMap.get(newHour.hour) || { hour: newHour.hour, attendances: 0, potentials: 0 };
                existingHour.attendances += newHour.attendances;
                existingHour.potentials += newHour.potentials;
                hourlyMap.set(newHour.hour, existingHour);
            }
            existingPerson.hourly = Array.from(hourlyMap.values()).sort((a,b) => a.hour - b.hour);
            existingPerson.totalAttendances = existingPerson.hourly.reduce((sum, h) => sum + h.attendances, 0);
            existingPerson.totalPotentials = existingPerson.hourly.reduce((sum, h) => sum + h.potentials, 0);
        }
    }
    return Array.from(mergedMap.values());
};

const mergeSalesData = (datasets: SalespersonSales[][]): SalespersonSales[] => {
    const mergedMap = new Map<string, SalespersonSales>();
    for (const dataset of datasets) {
        for (const newSale of dataset) {
            let existingSale = mergedMap.get(newSale.salesperson);
            if (!existingSale) {
                existingSale = { salesperson: newSale.salesperson, salesCount: 0, totalRevenue: 0, averageTicket: 0, itemsPerSale: 0 };
                mergedMap.set(newSale.salesperson, existingSale);
            }
            existingSale.salesCount += newSale.salesCount;
            existingSale.totalRevenue += newSale.totalRevenue;
            const totalSales = existingSale.salesCount;
            if (totalSales > 0) {
              existingSale.averageTicket = existingSale.totalRevenue / totalSales;
            }
        }
    }
    return Array.from(mergedMap.values());
};

type SortKey = keyof ConsolidatedData;
type SortDirection = 'ascending' | 'descending';


export default function SalesAnalyzer() {
  const [loadedAttendanceFiles, setLoadedAttendanceFiles] = useState<LoadedAttendanceFile[]>([]);
  const [loadedSalesFiles, setLoadedSalesFiles] = useState<LoadedSalesFile[]>([]);
  
  const [isLoading, setIsLoading] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  
  const [fileInputKey, setFileInputKey] = useState(Date.now());
  
  const [aiSummary, setAiSummary] = useState<SalesSummaryOutput | null>(null);
  const { toast } = useToast();

  const printRef = useRef<HTMLDivElement>(null);
  const mainTableRef = useRef<HTMLDivElement>(null);
  const rightColumnRef = useRef<HTMLDivElement>(null);

  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'conversionRate', direction: 'descending' });

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsLoading(true);
    const newAttendanceFiles: LoadedAttendanceFile[] = [];
    const newSalesFiles: LoadedSalesFile[] = [];
    const errors: string[] = [];

    const filePromises = Array.from(files).map(file => {
        return new Promise<void>((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const text = e.target?.result as string;
                    if (text.includes('At.;Pot.')) {
                        if (!loadedAttendanceFiles.some(f => f.name === file.name)) {
                            const { data, dateRange } = parseAttendanceCsv(text);
                            newAttendanceFiles.push({ name: file.name, content: text, dateRange, parsedData: data });
                        }
                    } else {
                         if (!loadedSalesFiles.some(f => f.name === file.name)) {
                            const data = parseSalesCsv(text);
                            newSalesFiles.push({ name: file.name, content: text, parsedData: data });
                        }
                    }
                } catch (err) {
                    const errorMsg = err instanceof Error ? err.message : `Erro ao processar ${file.name}`;
                    errors.push(`${file.name}: ${errorMsg}`);
                }
                resolve();
            };
            reader.onerror = () => {
                errors.push(`Erro ao ler o arquivo ${file.name}`);
                resolve();
            };
            reader.readAsText(file, 'UTF-8');
        });
    });

    Promise.all(filePromises).then(() => {
        setLoadedAttendanceFiles(current => [...current, ...newAttendanceFiles]);
        setLoadedSalesFiles(current => [...current, ...newSalesFiles]);

        const totalNewFiles = newAttendanceFiles.length + newSalesFiles.length;
        if (totalNewFiles > 0) {
            toast({ title: "Arquivos Carregados", description: `${totalNewFiles} novo(s) arquivo(s) processado(s) com sucesso.` });
        }
        if (errors.length > 0) {
            toast({ variant: "destructive", title: "Erros no Upload", description: errors.join('; ') });
        }

        setIsLoading(false);
        setFileInputKey(Date.now()); // Reseta o input para permitir o mesmo arquivo novamente se necessário
    });

}, [toast, loadedAttendanceFiles, loadedSalesFiles]);
  
  const handleGeneratePdf = useCallback(async () => {
    const mainTableEl = mainTableRef.current;
    const rightColumnEl = rightColumnRef.current;

    if (!mainTableEl || !rightColumnEl) {
        toast({ variant: "destructive", title: "Erro ao gerar PDF", description: "Não foi possível encontrar o conteúdo para imprimir." });
        return;
    }

    setIsGeneratingPdf(true);

    try {
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = pdf.internal.pageSize.getHeight();
        const margin = 15;
        let yPos = margin;

        const addElementToPdf = async (element: HTMLElement) => {
            const canvas = await html2canvas(element, { scale: 2, backgroundColor: null });
            const imgData = canvas.toDataURL('image/png');
            const imgHeight = (canvas.height * (pdfWidth - margin * 2)) / canvas.width;

            if (yPos + imgHeight > pdfHeight - margin) {
                pdf.addPage();
                yPos = margin;
            }

            pdf.addImage(imgData, 'PNG', margin, yPos, pdfWidth - margin * 2, imgHeight);
            yPos += imgHeight + 10;
        };

        // Renderiza a coluna da direita primeiro
        await addElementToPdf(rightColumnEl);
        
        // Agora, renderiza a tabela principal, com paginação
        const canvas = await html2canvas(mainTableEl, { scale: 2 });
        const imgData = canvas.toDataURL('image/png');
        const imgHeight = (canvas.height * (pdfWidth - margin * 2)) / canvas.width;
        
        let heightLeft = imgHeight;
        let tableYPos = 0;

        // Adiciona a primeira parte da tabela
        if (yPos + Math.min(heightLeft, pdfHeight - margin - yPos) > pdfHeight - margin) {
            pdf.addPage();
            yPos = margin;
        }
        pdf.addImage(imgData, 'PNG', margin, yPos, pdfWidth - margin * 2, imgHeight, undefined, 'FAST', tableYPos);

        heightLeft -= (pdfHeight - yPos - margin);
        tableYPos += (pdfHeight - yPos - margin) * (canvas.width / (pdfWidth - margin * 2));

        // Adiciona o restante em novas páginas, se necessário
        while (heightLeft > 0) {
            pdf.addPage();
            yPos = margin;
            pdf.addImage(imgData, 'PNG', margin, yPos, pdfWidth - margin * 2, imgHeight, undefined, 'FAST', tableYPos);
            heightLeft -= pdfHeight - margin * 2;
            tableYPos += (pdfHeight - margin * 2) * (canvas.width / (pdfWidth - margin * 2));
        }

        pdf.save('relatorio-de-vendas.pdf');

    } catch (error) {
        console.error("Erro ao gerar PDF:", error);
        toast({ variant: "destructive", title: "Erro ao gerar PDF", description: "Ocorreu um problema ao tentar criar o arquivo PDF." });
    } finally {
        setIsGeneratingPdf(false);
    }
}, [toast]);
  
  const activeData = useMemo(() => {
    const attendanceData = mergeAttendanceData(loadedAttendanceFiles.map(f => f.parsedData));
    const salesData = mergeSalesData(loadedSalesFiles.map(f => f.parsedData));
    
    const allSalespeople = new Set([...attendanceData.map(p => p.salesperson), ...salesData.map(s => s.salesperson)]);

    const consolidatedData: ConsolidatedData[] = Array.from(allSalespeople).map(name => {
        const performance = attendanceData.find(p => p.salesperson === name);
        const sales = salesData.find(s => s.salesperson === name);

        const totalAttendances = performance?.totalAttendances ?? 0;
        const salesCount = sales?.salesCount ?? 0;
        
        return {
            salesperson: name,
            hourly: performance?.hourly ?? [],
            totalAttendances: totalAttendances,
            totalPotentials: performance?.totalPotentials ?? 0,
            salesCount: salesCount,
            totalRevenue: sales?.totalRevenue ?? 0,
            averageTicket: sales?.averageTicket ?? 0,
            itemsPerSale: sales?.itemsPerSale ?? 0,
            conversionRate: totalAttendances > 0 ? (salesCount / totalAttendances) : 0,
        };
    });
    
    const combinedAttendanceCsv = loadedAttendanceFiles.map(f => f.content).join('\n\n');
    const combinedSalesCsv = loadedSalesFiles.map(f => f.content).join('\n\n');

    let displayDateRange: { start: Date, end: Date } | null = null;
    if (loadedAttendanceFiles.length > 0) {
        const allDates = loadedAttendanceFiles.flatMap(f => [f.dateRange.start, f.dateRange.end]);
        const minDate = new Date(Math.min(...allDates.map(d => d.getTime())));
        const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));
        displayDateRange = { start: minDate, end: maxDate };
    }

    return { consolidatedData, combinedAttendanceCsv, combinedSalesCsv, displayDateRange };

  }, [loadedAttendanceFiles, loadedSalesFiles]);

  const runAiAnalysis = useCallback(() => {
    if (!activeData.combinedAttendanceCsv || !activeData.combinedSalesCsv) {
        toast({ variant: "destructive", title: "Dados Incompletos", description: "Carregue arquivos de atendimento e vendas para gerar insights." });
        return;
    }
    
    const dateRangeString = activeData.displayDateRange 
        ? `${format(activeData.displayDateRange.start, "dd/MM/yyyy")} - ${format(activeData.displayDateRange.end, "dd/MM/yyyy")}`
        : 'N/A';

    setIsAiLoading(true);
    summarizeSalesData({ 
        attendanceCsvData: activeData.combinedAttendanceCsv, 
        salesCsvData: activeData.combinedSalesCsv, 
        dateRange: dateRangeString
    })
      .then(setAiSummary)
      .catch(aiError => {
        console.error("Falha na análise de IA:", aiError);
        toast({ variant: "destructive", title: "Falha na Análise de IA", description: aiError instanceof Error ? aiError.message : "Não foi possível gerar insights." });
        setAiSummary(null);
      })
      .finally(() => setIsAiLoading(false));
  }, [activeData, toast]);
  
  const requestSort = (key: SortKey) => {
    let direction: SortDirection = 'descending';
    if (sortConfig.key === key && sortConfig.direction === 'descending') {
      direction = 'ascending';
    }
    setSortConfig({ key, direction });
  };
  
  const sortedDisplayData = useMemo(() => {
    const sortableItems = [...activeData.consolidatedData];
    if (sortConfig.key) {
      sortableItems.sort((a, b) => {
        const aValue = a[sortConfig.key];
        const bValue = b[sortConfig.key];

        if (typeof aValue === 'string' && typeof bValue === 'string') {
           if (aValue.toLowerCase() < bValue.toLowerCase()) {
              return sortConfig.direction === 'ascending' ? -1 : 1;
           }
           if (aValue.toLowerCase() > bValue.toLowerCase()) {
              return sortConfig.direction === 'ascending' ? 1 : -1;
           }
           return 0;
        } else if (typeof aValue === 'number' && typeof bValue === 'number') {
           if (aValue < bValue) {
              return sortConfig.direction === 'ascending' ? -1 : 1;
           }
           if (aValue > bValue) {
              return sortConfig.direction === 'ascending' ? 1 : -1;
           }
           return 0;
        }
        return 0;
      });
    }
    return sortableItems;
  }, [activeData.consolidatedData, sortConfig]);
  
  const totalAttendances = useMemo(() => activeData.consolidatedData.reduce((sum, p) => sum + p.totalAttendances, 0), [activeData.consolidatedData]);
  const totalSalesCount = useMemo(() => activeData.consolidatedData.reduce((sum, p) => sum + p.salesCount, 0), [activeData.consolidatedData]);
  const totalRevenue = useMemo(() => activeData.consolidatedData.reduce((sum, p) => sum + p.totalRevenue, 0), [activeData.consolidatedData]);
  const averageConversionRate = useMemo(() => totalAttendances > 0 ? (totalSalesCount / totalAttendances) : 0, [totalAttendances, totalSalesCount]);
  
  const bestSalesperson = useMemo(() => {
      if (sortedDisplayData.length === 0) return null;
      // Assume o primeiro item após a ordenação padrão (melhor conversão)
      return sortedDisplayData.reduce((best, current) => current.conversionRate > best.conversionRate ? current : best, sortedDisplayData[0]);
  }, [sortedDisplayData]);

  const conversionChartData = useMemo(() => {
    return [...activeData.consolidatedData]
      .sort((a, b) => b.conversionRate - a.conversionRate)
      .slice(0, 5)
      .map((item, index) => ({
        name: item.salesperson.split(' ')[0],
        value: parseFloat((item.conversionRate * 100).toFixed(1)),
        rank: index + 1,
      }));
  }, [activeData.consolidatedData]);

  
  const SortableHeader = ({ tKey, label, className }: { tKey: SortKey, label: string, className?: string }) => {
    const isActive = sortConfig.key === tKey;
    const directionIcon = isActive ? (sortConfig.direction === 'ascending' ? <ArrowUp className="ml-2 h-4 w-4 inline-block" /> : <ArrowDown className="ml-2 h-4 w-4 inline-block" />) : <ArrowUpDown className="ml-2 h-4 w-4 inline-block opacity-30 group-hover:opacity-100" />;

    return (
        <TableHead className={className}>
            <Button variant="ghost" onClick={() => requestSort(tKey)} className="group p-0 h-auto font-bold w-full justify-start data-[align=right]:justify-end text-xs" data-align={className?.includes('text-right') ? 'right' : 'left'}>
                {label}
                {directionIcon}
            </Button>
        </TableHead>
    )
  };

  const hasFiles = loadedAttendanceFiles.length > 0 || loadedSalesFiles.length > 0;

  return (
    <div className="min-h-screen w-full p-4 sm:p-6 md:p-8 bg-secondary/80">
      <div ref={printRef}>
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
              <h1 className="font-headline text-3xl font-bold text-foreground flex items-center gap-3">
                  <BarChartIcon className="text-accent"/>
                  Planilha Inteligente
              </h1>
              <p className="text-muted-foreground mt-1">Análise automática com IA • Insights em tempo real</p>
          </div>
          <div className="flex items-center gap-2">
              <label htmlFor="file-upload" className="cursor-pointer">
                  <Button asChild variant="outline" className="bg-white">
                      <span>
                          <UploadCloud className="mr-2 text-primary" />
                          Upload Arquivos
                      </span>
                  </Button>
                  <input id="file-upload" key={fileInputKey} type="file" className="hidden" accept=".csv,.txt" onChange={handleFileUpload} multiple disabled={isLoading}/>
              </label>
              <Button onClick={runAiAnalysis} disabled={isAiLoading || !hasFiles} className="bg-accent hover:bg-accent/90">
                  {isAiLoading ? <Loader2 className="mr-2 animate-spin" /> : <Sparkles className="mr-2" />}
                  Gerar Insights
              </Button>
              <Button onClick={handleGeneratePdf} disabled={isGeneratingPdf || !hasFiles} variant="outline" className="bg-white">
                  {isGeneratingPdf ? <Loader2 className="mr-2 animate-spin" /> : <FileDown className="mr-2" />}
                  Exportar PDF
              </Button>
          </div>
        </header>
        
        <main className="space-y-6">
          {isLoading && (<div className="flex items-center justify-center text-primary rounded-lg bg-card p-4"><Loader2 className="mr-2 h-5 w-5 animate-spin" /><span>Processando arquivos...</span></div>)}
          
          {!hasFiles && !isLoading && (
              <Card className="w-full p-6 text-center shadow-lg border-0 bg-card mt-6">
                  <CardHeader>
                      <div className="mx-auto bg-primary/10 p-4 rounded-full w-fit"><HelpCircle className="w-10 h-10 text-primary" /></div>
                      <CardTitle className="font-headline text-3xl mt-4">Bem-vindo à Planilha Inteligente</CardTitle>
                      <CardDescription>Para começar, clique em <span className="font-semibold text-primary">"Upload Arquivos"</span> e carregue seus arquivos de atendimento e vendas.</CardDescription>
                  </CardHeader>
              </Card>
          )}

          {hasFiles && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in-50">
              {/* Coluna Esquerda */}
              <div ref={mainTableRef} className="lg:col-span-2 space-y-6">
                  {activeData.displayDateRange && (
                      <Card>
                          <CardHeader>
                              <CardTitle className="flex items-center gap-2 font-headline text-lg">
                                  <CalendarIcon className="text-primary"/>
                                  Período da Análise
                              </CardTitle>
                          </CardHeader>
                          <CardContent className="flex items-center gap-4 text-center">
                              <div>
                                  <p className="text-sm text-muted-foreground">Data Inicial</p>
                                  <p className="font-bold text-lg">{format(activeData.displayDateRange.start, "dd/MM/yyyy")}</p>
                              </div>
                              <div className="text-muted-foreground">→</div>
                              <div>
                                  <p className="text-sm text-muted-foreground">Data Final</p>
                                  <p className="font-bold text-lg">{format(activeData.displayDateRange.end, "dd/MM/yyyy")}</p>
                              </div>
                          </CardContent>
                      </Card>
                  )}
                  <Card>
                      <CardHeader>
                          <CardTitle className="flex items-center gap-2 font-headline text-lg">
                              <Target className="text-primary"/>
                              Taxa de Conversão por Vendedora
                          </CardTitle>
                      </CardHeader>
                      <CardContent>
                          <Table>
                              <TableHeader>
                                  <TableRow>
                                      <SortableHeader tKey="salesperson" label="Vendedora" />
                                      <SortableHeader tKey="totalAttendances" label="Atendimentos" className="text-right" />
                                      <SortableHeader tKey="salesCount" label="Vendas" className="text-right" />
                                      <SortableHeader tKey="conversionRate" label="Conversão (%)" className="text-right" />
                                      <SortableHeader tKey="totalRevenue" label="Receita (R$)" className="text-right" />
                                  </TableRow>
                              </TableHeader>
                              <TableBody>
                                  {sortedDisplayData.length > 0 ? sortedDisplayData.map((item) => (
                                      <TableRow key={item.salesperson} className="text-sm">
                                          <TableCell className="font-medium">
                                              {item.salesperson}
                                          </TableCell>
                                          <TableCell className="text-right">{item.totalAttendances}</TableCell>
                                          <TableCell className="text-right">{item.salesCount}</TableCell>
                                          <TableCell className={`text-right font-bold ${item.conversionRate > averageConversionRate ? 'text-green-600' : 'text-amber-600'}`}>
                                            <div className={`p-1 rounded-md inline-block ${item.conversionRate > averageConversionRate ? 'bg-green-100' : 'bg-amber-100'}`}>
                                              {(item.conversionRate * 100).toFixed(1)}%
                                            </div>
                                          </TableCell>
                                          <TableCell className="text-right font-medium">{item.totalRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</TableCell>
                                      </TableRow>
                                  )) : <TableRow><TableCell colSpan={5} className="h-24 text-center">Nenhum dado para exibir.</TableCell></TableRow>}
                              </TableBody>
                          </Table>
                      </CardContent>
                  </Card>
              </div>

              {/* Coluna Direita */}
              <div ref={rightColumnRef} className="space-y-6">
                  <Card>
                      <CardHeader>
                          <CardTitle className="flex items-center gap-2 font-headline text-lg">
                              <Folder className="text-primary"/>
                              Arquivos Carregados
                          </CardTitle>
                      </CardHeader>
                      <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                          {loadedAttendanceFiles.map(file => (
                              <div key={file.name} className="bg-green-50 border-2 border-green-200 rounded-lg p-3 text-center">
                                  <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
                                  <p className="text-sm font-medium text-green-800 break-words">{file.name}</p>
                                  <p className="text-xs text-green-600">Atendimento</p>
                              </div>
                          ))}
                          {loadedSalesFiles.map(file => (
                              <div key={file.name} className="bg-blue-50 border-2 border-blue-200 rounded-lg p-3 text-center">
                                  <File className="w-8 h-8 text-blue-500 mx-auto mb-2" />
                                  <p className="text-sm font-medium text-blue-800 break-words">{file.name}</p>
                                  <p className="text-xs text-blue-600">Vendas</p>
                              </div>
                          ))}
                      </CardContent>
                  </Card>

                  {(isAiLoading || aiSummary) && (
                    <Card>
                      <CardHeader><CardTitle className="flex items-center gap-2 font-headline text-lg"><Sparkles className="text-accent" />Insights da IA</CardTitle></CardHeader>
                      <CardContent className="space-y-3">
                        {isAiLoading ? (
                          <>
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-8 w-5/6" />
                            <Skeleton className="h-8 w-full" />
                          </>
                        ) : aiSummary ? (
                          aiSummary.highlights.map((h, i) => (
                            <div key={i} className="flex items-start gap-3 text-sm p-2 rounded-lg bg-yellow-50 border border-yellow-200">
                              <Lightbulb className="w-4 h-4 mt-1 shrink-0 text-yellow-600"/>
                              <p className="text-yellow-800">{h}</p>
                            </div>
                          ))
                        ) : null}
                      </CardContent>
                    </Card>
                  )}
                  
                  <Card>
                      <CardHeader><CardTitle className="flex items-center gap-2 font-headline text-lg"><BarChartIcon className="text-primary"/>Estatísticas</CardTitle></CardHeader>
                      <CardContent className="space-y-4 text-sm">
                          <div className="flex justify-between items-center">
                              <span className="text-muted-foreground">Taxa Média de Conversão:</span>
                              <span className="font-bold text-lg text-primary">{(averageConversionRate * 100).toFixed(1)}%</span>
                          </div>
                          <div className="flex justify-between items-center">
                              <span className="text-muted-foreground">Total de Atendimentos:</span>
                              <span className="font-bold text-lg text-primary">{totalAttendances}</span>
                          </div>
                          <div className="flex justify-between items-center">
                              <span className="text-muted-foreground">Melhor Vendedora:</span>
                              <span className="font-bold text-lg text-accent">{bestSalesperson?.salesperson.split(' ')[0] ?? 'N/A'}</span>
                          </div>
                          <div className="flex justify-between items-center">
                              <span className="text-muted-foreground">Faturamento Total:</span>
                              <span className="font-bold text-lg text-green-600">{totalRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
                          </div>
                      </CardContent>
                  </Card>

                  <Card className="bg-gradient-to-br from-pink-400 to-rose-400 text-white">
                      <CardHeader><CardTitle className="flex items-center gap-2 font-headline text-lg"><TrendingUp/>Taxa de Conversão por Vendedora</CardTitle></CardHeader>
                      <CardContent className="space-y-4">
                          {conversionChartData.map((item, index) => {
                              const rankColor = index === 0 ? 'text-yellow-300' : index === 1 ? 'text-gray-300' : index === 2 ? 'text-yellow-500' : '';
                              return (
                                  <div key={item.name}>
                                      <div className="flex justify-between items-center text-sm mb-1">
                                          <span className="flex items-center gap-2">
                                              {index < 3 && <Trophy className={`w-5 h-5 ${rankColor}`} />}
                                              {item.name}
                                          </span>
                                          <span>{item.value}%</span>
                                      </div>
                                      <Progress value={item.value} className="h-2 bg-white/30" indicatorClassName="bg-white"/>
                                  </div>
                              );
                          })}
                      </CardContent>
                  </Card>

                  {aiSummary?.recommendations && aiSummary.recommendations.length > 0 && (
                    <Card className="bg-gradient-to-br from-purple-500 to-indigo-600 text-white">
                      <CardHeader><CardTitle className="flex items-center gap-2 font-headline text-lg"><Lightbulb/>Sugestões Inteligentes</CardTitle></CardHeader>
                      <CardContent className="space-y-3">
                        {aiSummary.recommendations.map((rec, i) => (
                          <div key={i} className="flex items-start gap-3 text-sm p-3 rounded-lg bg-white/20">
                            <CheckCircle className="w-4 h-4 mt-1 shrink-0"/>
                            <p>{rec}</p>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
              </div>
          </div>
          )}
        </main>
      </div>
    </div>
  );
}

    