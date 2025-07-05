
"use client";

import { useState, useMemo, useCallback, useEffect } from 'react';
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
    TrendingUp, CheckCircle, DollarSign, HelpCircle, Cog, FileDown, ArrowUp, ArrowDown, ArrowUpDown
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';

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
        // Common date formats for Brazil and others
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
        if (rawSalesperson.toLowerCase() === 'total' || !rawSalesperson) continue;
        const salesperson = cleanSalespersonName(rawSalesperson);
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
    if (parsedData.length === 0) throw new Error("Nenhum dado de atendimento válido encontrado.");
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
    
    const dataRows = lines.slice(1); // Pular cabeçalho
    const parseCurrency = (str: string) => parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
    const parseIntSimple = (str: string) => parseInt(str, 10) || 0;
    const parseFloatSimple = (str: string) => parseFloat(str.replace(',', '.')) || 0;
    
    const parsedData: SalespersonSales[] = [];
    for (const row of dataRows) {
        const values = row.split(';').map(v => v.trim());
        if (values.length < 11) continue; // Basic validation for row length
        const rawSalespersonName = values[0]; // 'Vendedor' is at index 0
        if (rawSalespersonName?.toLowerCase() === 'total' || !rawSalespersonName) continue;
        
        parsedData.push({
            salesperson: cleanSalespersonName(rawSalespersonName),
            salesCount: parseIntSimple(values[2]),       // 'Vendas' is at index 2
            itemsPerSale: parseFloatSimple(values[6]),   // 'P.A.' is at index 6
            totalRevenue: parseCurrency(values[8]),      // 'Total Vendas' is at index 8
            averageTicket: parseCurrency(values[10]),    // 'Ticket Médio' is at index 10
        });
    }
    if (parsedData.length === 0) throw new Error("Nenhum dado de vendas válido encontrado.");
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
            // Recalcular médias ponderadas
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
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [filterDateRange, setFilterDateRange] = useState<DateRange | undefined>();
  
  const [isLoading, setIsLoading] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  
  const [attendanceInputKey, setAttendanceInputKey] = useState(Date.now());
  const [salesInputKey, setSalesInputKey] = useState(Date.now());
  
  const [aiSummary, setAiSummary] = useState<SalesSummaryOutput | null>(null);
  const { toast } = useToast();

  const [selectedSalesperson, setSelectedSalesperson] = useState<string>('all');
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'totalRevenue', direction: 'descending' });

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>, type: 'attendance' | 'sales') => {
    const file = event.target.files?.[0];
    if (!file) return;

    const existingFiles = type === 'attendance' ? loadedAttendanceFiles : loadedSalesFiles;
    if (existingFiles.some(f => f.name === file.name)) {
        toast({ variant: "destructive", title: "Arquivo Duplicado", description: `O arquivo "${file.name}" já foi carregado.` });
        if (type === 'attendance') setAttendanceInputKey(Date.now()); else setSalesInputKey(Date.now());
        return;
    }

    setIsLoading(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        if (type === 'attendance') {
            const { data: newParsedData, dateRange } = parseAttendanceCsv(text);
            const newFile: LoadedAttendanceFile = { name: file.name, content: text, dateRange: dateRange, parsedData: newParsedData };
            setLoadedAttendanceFiles(currentFiles => [...currentFiles, newFile]);
            toast({ title: "Arquivo de Atendimento Carregado", description: `Dados de "${file.name}" adicionados.` });
        } else { // type === 'sales'
            const newParsedData = parseSalesCsv(text);
            const newFile: LoadedSalesFile = { name: file.name, content: text, parsedData: newParsedData };
            setLoadedSalesFiles(currentFiles => [...currentFiles, newFile]);
            toast({ title: "Arquivo de Vendas Carregado", description: `Dados de "${file.name}" adicionados.` });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Ocorreu um erro desconhecido.";
        toast({ variant: "destructive", title: "Falha no Upload", description: errorMsg });
      } finally {
        setIsLoading(false);
        if (type === 'attendance') setAttendanceInputKey(Date.now()); else setSalesInputKey(Date.now());
      }
    };
    reader.onerror = () => {
      setIsLoading(false);
      toast({ variant: "destructive", title: "Erro de Leitura de Arquivo" });
    };
    reader.readAsText(file, 'UTF-8');
  }, [toast, loadedAttendanceFiles, loadedSalesFiles]);
  
  const activeData = useMemo(() => {
    // 1. Determine which attendance files are in the filtered date range.
    const attendanceFilesToProcess = filterDateRange?.from
      ? loadedAttendanceFiles.filter(file => {
          const fileInterval = { start: file.dateRange.start, end: file.dateRange.end };
          const filterInterval = { start: startOfDay(filterDateRange.from!), end: endOfDay(filterDateRange.to ?? filterDateRange.from!) };
          // Check if file's date range overlaps with the filter's date range.
          return isWithinInterval(fileInterval.start, filterInterval) || isWithinInterval(fileInterval.end, filterInterval) || 
                 (fileInterval.start <= filterInterval.start && fileInterval.end >= filterInterval.end);
        })
      : loadedAttendanceFiles;

    // 2. Merge all sales data once, it will be filtered later if needed.
    const allMergedSales = mergeSalesData(loadedSalesFiles.map(f => f.parsedData));

    // Exit early if there are no files loaded at all.
    if (loadedAttendanceFiles.length === 0 && loadedSalesFiles.length === 0) {
        return { consolidatedData: [], combinedAttendanceCsv: '', combinedSalesCsv: '', displayDateRange: 'Nenhum dado para o período' };
    }
    
    // 3. Merge performance data from ONLY the relevant attendance files.
    const mergedPerformances = mergeAttendanceData(attendanceFilesToProcess.map(f => f.parsedData));
    
    // 4. Determine the final list of sales data. If filtering by date, use only sales from salespeople active in that period.
    const activeSalespeopleInPeriod = new Set(mergedPerformances.map(p => p.salesperson));
    const mergedSales = filterDateRange?.from
        ? allMergedSales.filter(s => activeSalespeopleInPeriod.has(s.salesperson))
        : allMergedSales;

    // 5. The final list of salespeople is the union of the (filtered) performances and (filtered) sales.
    const salespeopleToShow = new Set([...mergedPerformances.map(p => p.salesperson), ...mergedSales.map(s => s.salesperson)]);

    const consolidatedData: ConsolidatedData[] = Array.from(salespeopleToShow).map(name => {
        const performanceData = mergedPerformances.find(p => p.salesperson === name);
        const salesData = mergedSales.find(s => s.salesperson === name);

        const totalAttendances = performanceData?.totalAttendances ?? 0;
        const salesCount = salesData?.salesCount ?? 0;
        
        return {
            salesperson: name,
            hourly: performanceData?.hourly ?? [],
            totalAttendances: totalAttendances,
            totalPotentials: performanceData?.totalPotentials ?? 0,
            salesCount: salesCount,
            totalRevenue: salesData?.totalRevenue ?? 0,
            averageTicket: salesData?.averageTicket ?? 0,
            itemsPerSale: salesData?.itemsPerSale ?? 0,
            conversionRate: totalAttendances > 0 ? (salesCount / totalAttendances) : 0,
        };
    });
    
    // 6. Create combined CSVs for AI analysis.
    const combinedAttendanceCsv = attendanceFilesToProcess.map(f => f.content).join('\n\n');
    const combinedSalesCsv = loadedSalesFiles.map(f => f.content).join('\n\n');

    let displayDateRange: string;
    if (filterDateRange?.from) {
        const startDate = format(filterDateRange.from, "dd/MM/yy", { locale: ptBR });
        const endDate = filterDateRange.to ? format(filterDateRange.to, "dd/MM/yy", { locale: ptBR }) : null;
        displayDateRange = endDate ? `${startDate} - ${endDate}` : startDate;
    } else if (loadedAttendanceFiles.length > 0) {
        const allDates = loadedAttendanceFiles.flatMap(f => [f.dateRange.start, f.dateRange.end]);
        const minDate = new Date(Math.min(...allDates.map(d => d.getTime())));
        const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));
        displayDateRange = `${format(minDate, "dd/MM/yyyy")} - ${format(maxDate, "dd/MM/yyyy")}`;
    } else {
        displayDateRange = 'Nenhum período de atendimento carregado';
    }

    return { consolidatedData, combinedAttendanceCsv, combinedSalesCsv, displayDateRange };

  }, [loadedAttendanceFiles, loadedSalesFiles, filterDateRange]);


  useEffect(() => {
    if (!activeData.combinedAttendanceCsv || !activeData.combinedSalesCsv) {
        setAiSummary(null);
        return;
    }
    
    setIsAiLoading(true);
    summarizeSalesData({ 
        attendanceCsvData: activeData.combinedAttendanceCsv, 
        salesCsvData: activeData.combinedSalesCsv, 
        dateRange: activeData.displayDateRange 
    })
      .then(setAiSummary)
      .catch(aiError => {
        console.error("Falha na análise de IA:", aiError);
        toast({ variant: "destructive", title: "Falha na Análise de IA", description: aiError instanceof Error ? aiError.message : "Não foi possível gerar insights." });
        setAiSummary(null);
      })
      .finally(() => setIsAiLoading(false));
  }, [activeData.combinedAttendanceCsv, activeData.combinedSalesCsv, activeData.displayDateRange, toast]);

  const resetData = useCallback(() => {
    setLoadedAttendanceFiles([]);
    setLoadedSalesFiles([]);
    setSelectedSalesperson('all');
    setAiSummary(null);
    setFilterDateRange(undefined);
    setAttendanceInputKey(Date.now());
    setSalesInputKey(Date.now());
    setIsImportOpen(false);
    toast({ title: "Dados Resetados", description: "Pode começar uma nova análise." });
  }, [toast]);
  
  const handleGeneratePdf = useCallback(async () => {
    const triggerElements = document.querySelectorAll<HTMLElement>('[data-pdf-hide]');
    triggerElements.forEach(el => el.style.display = 'none');

    const input = document.getElementById('report-content');
    if (!input) {
      toast({
        variant: "destructive",
        title: "Erro ao gerar PDF",
        description: "Elemento do relatório não encontrado.",
      });
      triggerElements.forEach(el => el.style.display = 'flex');
      return;
    }

    setIsGeneratingPdf(true);

    try {
      const canvas = await html2canvas(input, {
        scale: 2,
        useCORS: true,
      });

      triggerElements.forEach(el => el.style.display = 'flex');

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({
        orientation: 'p',
        unit: 'mm',
        format: 'a4',
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      
      const imgProps = pdf.getImageProperties(imgData);
      const imgWidth = pdfWidth;
      const imgHeight = (imgProps.height * imgWidth) / imgProps.width;

      let heightLeft = imgHeight;
      let position = 0;

      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= pdfHeight;

      while (heightLeft > 0) {
        position = -heightLeft;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= pdfHeight;
      }
      
      const today = new Date();
      const formattedDate = format(today, 'dd-MM-yyyy');
      pdf.save(`relatorio-de-desempenho-${formattedDate}.pdf`);

    } catch (error) {
      console.error("Erro ao gerar PDF:", error);
      toast({
        variant: "destructive",
        title: "Erro ao Gerar PDF",
        description: "Ocorreu um problema ao tentar criar o arquivo PDF.",
      });
      triggerElements.forEach(el => el.style.display = 'flex');
    } finally {
      setIsGeneratingPdf(false);
    }
  }, [toast]);
  
  const { consolidatedData } = activeData;

  const uniqueSalespeople = useMemo(() => ['all', ...consolidatedData.map(d => d.salesperson).sort()], [consolidatedData]);

  const displayData = useMemo(() => {
    if (selectedSalesperson === 'all') return consolidatedData;
    return consolidatedData.filter(d => d.salesperson === selectedSalesperson);
  }, [consolidatedData, selectedSalesperson]);
  
  const requestSort = (key: SortKey) => {
    let direction: SortDirection = 'descending';
    if (sortConfig.key === key && sortConfig.direction === 'descending') {
      direction = 'ascending';
    }
    setSortConfig({ key, direction });
  };
  
  const sortedDisplayData = useMemo(() => {
    const sortableItems = [...displayData];
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
  }, [displayData, sortConfig]);
  
  const totalAttendances = useMemo(() => displayData.reduce((sum, p) => sum + p.totalAttendances, 0), [displayData]);
  const totalSalesCount = useMemo(() => displayData.reduce((sum, p) => sum + p.salesCount, 0), [displayData]);
  const totalRevenue = useMemo(() => displayData.reduce((sum, p) => sum + p.totalRevenue, 0), [displayData]);
  const averageConversionRate = useMemo(() => totalAttendances > 0 ? (totalSalesCount / totalAttendances) : 0, [totalAttendances, totalSalesCount]);

  const hourlyTotals = useMemo(() => {
    const totals = new Map<number, { attendances: number, potentials: number }>();
    displayData.forEach(person => {
        person.hourly.forEach(h => {
            const current = totals.get(h.hour) || { attendances: 0, potentials: 0 };
            current.attendances += h.attendances;
            current.potentials += h.potentials;
            totals.set(h.hour, current);
        });
    });
    return Array.from(totals.entries())
        .map(([hour, data]) => ({ name: `${String(hour).padStart(2, '0')}:00`, atendimentos: data.attendances, potenciais: data.potentials }))
        .sort((a, b) => a.name.localeCompare(b.name));
  }, [displayData]);

  const performanceBySalespersonChartData = useMemo(() => {
    return displayData
      .filter(item => item.totalAttendances > 0 || item.salesCount > 0)
      .map(item => ({
        name: item.salesperson.split(' ')[0],
        atendimentos: item.totalAttendances,
        vendas: item.salesCount,
        receita: item.totalRevenue,
      }))
      .sort((a, b) => b.receita - a.receita);
  }, [displayData]);
  
  const SortableHeader = ({ tKey, label, className }: { tKey: SortKey, label: string, className?: string }) => {
    const isActive = sortConfig.key === tKey;
    const directionIcon = isActive ? (sortConfig.direction === 'ascending' ? <ArrowUp className="ml-2 h-4 w-4 inline-block" /> : <ArrowDown className="ml-2 h-4 w-4 inline-block" />) : <ArrowUpDown className="ml-2 h-4 w-4 inline-block opacity-30 group-hover:opacity-100" />;

    return (
        <TableHead className={className}>
            <Button variant="ghost" onClick={() => requestSort(tKey)} className="group p-0 h-auto font-bold w-full justify-start data-[align=right]:justify-end" data-align={className?.includes('text-right') ? 'right' : 'left'}>
                {label}
                {directionIcon}
            </Button>
        </TableHead>
    )
  };

  return (
    <div className="min-h-screen animate-in fade-in-50 bg-secondary/50">
      <header className="sticky top-0 z-30 bg-card shadow-sm">
        <div className="container mx-auto flex items-center justify-between p-4">
          <h1 className="font-headline text-2xl flex items-center gap-2 text-foreground">
            <BarChartIcon className="text-primary" />
            <span>Analisador de Vendas</span>
          </h1>
          <div className="flex items-center gap-2" data-pdf-hide>
              <Button onClick={handleGeneratePdf} variant="outline" disabled={isGeneratingPdf || (loadedAttendanceFiles.length === 0 && loadedSalesFiles.length === 0)}>
                  {isGeneratingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
                  Gerar PDF
              </Button>
              <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
                  <DialogTrigger asChild>
                      <Button variant="outline"><Cog className="mr-2 h-4 w-4" /> Configurar e Importar</Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[800px]">
                      <DialogHeader>
                          <DialogTitle className="font-headline text-2xl">Importar Dados</DialogTitle>
                          <DialogDescription>Carregue seus arquivos CSV. Os dados são acumulados a cada novo upload.</DialogDescription>
                      </DialogHeader>
                      <div className="grid md:grid-cols-2 gap-6 py-4">
                          <div>
                              <Label htmlFor="attendance-upload" className="font-semibold text-base mb-2 block">1. Atendimentos e Potenciais</Label>
                              <label htmlFor="attendance-upload" className="cursor-pointer group">
                                  <div className="border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center hover:border-primary hover:bg-primary/5 transition-colors">
                                      <UploadCloud className="w-10 h-10 text-muted-foreground group-hover:text-primary" />
                                      <p className="mt-4 text-sm text-muted-foreground"><span className="font-semibold text-primary">Clique para carregar</span> ou arraste</p>
                                      <p className="text-xs text-muted-foreground mt-1">Arquivo CSV de Atendimento</p>
                                  </div>
                                  <input key={attendanceInputKey} id="attendance-upload" type="file" className="hidden" accept=".csv,.txt" onChange={(e) => handleFileUpload(e, 'attendance')} disabled={isLoading} />
                              </label>
                          </div>
                          <div>
                              <Label htmlFor="sales-upload" className="font-semibold text-base mb-2 block">2. Vendas Realizadas (PDV)</Label>
                              <label htmlFor="sales-upload" className="cursor-pointer group">
                                  <div className="border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center hover:border-primary hover:bg-primary/5 transition-colors">
                                      <DollarSign className="w-10 h-10 text-muted-foreground group-hover:text-primary" />
                                      <p className="mt-4 text-sm text-muted-foreground"><span className="font-semibold text-primary">Clique para carregar</span> ou arraste</p>
                                      <p className="text-xs text-muted-foreground mt-1">Arquivo CSV de Vendas</p>
                                  </div>
                                  <input key={salesInputKey} id="sales-upload" type="file" className="hidden" accept=".csv,.txt" onChange={(e) => handleFileUpload(e, 'sales')} disabled={isLoading} />
                              </label>
                          </div>
                      </div>
                      {(loadedAttendanceFiles.length > 0 || loadedSalesFiles.length > 0) && (
                          <div className="mt-4 grid grid-cols-2 gap-4">
                              <div>
                                  <h3 className="font-semibold mb-2">Atendimentos Carregados</h3>
                                  <ScrollArea className="h-[100px] border rounded-md p-2"><ul className="space-y-1">{loadedAttendanceFiles.map(file => (<li key={file.name} className="text-sm text-muted-foreground">{file.name}</li>))}</ul></ScrollArea>
                              </div>
                               <div>
                                  <h3 className="font-semibold mb-2">Vendas Carregadas</h3>
                                  <ScrollArea className="h-[100px] border rounded-md p-2"><ul className="space-y-1">{loadedSalesFiles.map(file => (<li key={file.name} className="text-sm text-muted-foreground">{file.name}</li>))}</ul></ScrollArea>
                              </div>
                          </div>
                      )}
                      <DialogFooter>
                          {(loadedAttendanceFiles.length > 0 || loadedSalesFiles.length > 0) && (
                              <Button variant="destructive" onClick={resetData}><X className="mr-2 h-4 w-4" /> Limpar Tudo</Button>
                          )}
                          <Button onClick={() => setIsImportOpen(false)}>Fechar</Button>
                      </DialogFooter>
                  </DialogContent>
              </Dialog>
            </div>
        </div>
      </header>
      
      <main id="report-content" className="container mx-auto p-4 md:p-6 space-y-6">
        {isLoading && (<div className="flex items-center justify-center text-primary"><Loader2 className="mr-2 h-5 w-5 animate-spin" /><span>Processando arquivo...</span></div>)}
        {(loadedAttendanceFiles.length === 0 && loadedSalesFiles.length === 0) && !isLoading && (
            <Card className="w-full p-6 text-center shadow-lg border-0 bg-card mt-6">
                <CardHeader>
                    <div className="mx-auto bg-primary/10 p-4 rounded-full w-fit"><HelpCircle className="w-10 h-10 text-primary" /></div>
                    <CardTitle className="font-headline text-3xl mt-4">Bem-vindo ao Analisador de Vendas</CardTitle>
                    <CardDescription>Para começar, clique em <span className="font-semibold text-primary">"Configurar e Importar"</span> e carregue seus arquivos de atendimento e vendas.</CardDescription>
                </CardHeader>
            </Card>
        )}
        {(loadedAttendanceFiles.length > 0 || loadedSalesFiles.length > 0) && (
        <div className="animate-in fade-in-50">
            <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center mb-6" data-pdf-hide>
                <div className="flex-1">
                    <h2 className="text-2xl font-headline text-foreground">Dashboard de Desempenho</h2>
                    <p className="text-muted-foreground">Análise para o período: <span className="font-semibold text-primary">{activeData.displayDateRange}</span></p>
                </div>
                <div className="w-full flex-col md:flex-row flex gap-2">
                    <Popover><PopoverTrigger asChild><Button id="date" variant={"outline"} className={cn("w-full md:w-[280px] justify-start text-left font-normal", !filterDateRange && "text-muted-foreground")}><CalendarIcon className="mr-2 h-4 w-4" />{filterDateRange?.from ? (filterDateRange.to ? (<>{format(filterDateRange.from, "dd/MM/yy", { locale: ptBR })} - {format(filterDateRange.to, "dd/MM/yy", { locale: ptBR })}</>) : (format(filterDateRange.from, "dd/MM/yy", { locale: ptBR }))) : (<span>Filtrar por Período</span>)}</Button></PopoverTrigger><PopoverContent className="w-auto p-0" align="end"><Calendar initialFocus mode="range" defaultMonth={filterDateRange?.from} selected={filterDateRange} onSelect={setFilterDateRange} numberOfMonths={2} locale={ptBR} /></PopoverContent></Popover>
                    <Select onValueChange={setSelectedSalesperson} value={selectedSalesperson}><SelectTrigger id="salesperson-filter" className="w-full md:w-[250px] bg-card"><SelectValue placeholder="Selecione um(a) vendedor(a)" /></SelectTrigger><SelectContent>{uniqueSalespeople.map(person => <SelectItem key={person} value={person}>{person === 'all' ? 'Todos os Vendedores' : person}</SelectItem>)}</SelectContent></Select>
                </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Atendimentos</CardTitle><Users className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{totalAttendances}</div><p className="text-xs text-muted-foreground">Total de clientes atendidos</p></CardContent></Card>
                <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Vendas Realizadas</CardTitle><CheckCircle className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{totalSalesCount}</div><p className="text-xs text-muted-foreground">Total de transações</p></CardContent></Card>
                <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Taxa de Conversão</CardTitle><TrendingUp className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{(averageConversionRate * 100).toFixed(1)}%</div><p className="text-xs text-muted-foreground">Vendas / Atendimentos</p></CardContent></Card>
                <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Receita Total</CardTitle><DollarSign className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{totalRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</div><p className="text-xs text-muted-foreground">Soma de todas as vendas</p></CardContent></Card>
            </div>
            <div className="grid gap-6 lg:grid-cols-5 mt-6">
                <div className="lg:col-span-3 space-y-6">
                    <Card>
                        <CardHeader><CardTitle className="font-headline">Desempenho por Hora</CardTitle><CardDescription>Atendimentos vs Potenciais ao longo do dia.</CardDescription></CardHeader>
                        <CardContent className="pl-2">
                            <ChartContainer config={{ atendimentos: { label: 'Atendimentos', color: 'hsl(var(--chart-1))' }, potenciais: { label: 'Potenciais', color: 'hsl(var(--chart-2))' }, }} className="h-[300px] w-full">
                                <BarChart data={hourlyTotals} accessibilityLayer><CartesianGrid vertical={false} /><XAxis dataKey="name" tickLine={false} tickMargin={10} axisLine={false} fontSize={12} /><YAxis tickLine={false} axisLine={false} fontSize={12} /><Tooltip cursor={{fill: 'hsl(var(--muted))'}} content={<ChartTooltipContent />} /><Legend /><Bar dataKey="atendimentos" fill="var(--color-atendimentos)" radius={[4, 4, 0, 0]} /><Bar dataKey="potenciais" fill="var(--color-potenciais)" radius={[4, 4, 0, 0]} /></BarChart>
                            </ChartContainer>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle className="font-headline flex items-center gap-2">
                                <Target className="h-5 w-5 text-accent" />
                                Atendimentos vs. Vendas por Vendedor
                            </CardTitle>
                            <CardDescription>Comparativo de esforço (atendimentos) e resultado (vendas).</CardDescription>
                        </CardHeader>
                        <CardContent className="pl-2">
                            <ChartContainer config={{
                                atendimentos: { label: 'Atendimentos', color: 'hsl(var(--chart-1))' },
                                vendas: { label: 'Vendas', color: 'hsl(var(--chart-2))' },
                            }} className="h-[300px] w-full">
                                <BarChart data={performanceBySalespersonChartData} accessibilityLayer>
                                    <CartesianGrid vertical={false} />
                                    <XAxis dataKey="name" tickLine={false} tickMargin={10} axisLine={false} fontSize={12} />
                                    <YAxis tickLine={false} axisLine={false} fontSize={12} />
                                    <Tooltip cursor={{fill: 'hsl(var(--muted))'}} content={<ChartTooltipContent />} />
                                    <Legend />
                                    <Bar dataKey="atendimentos" fill="var(--color-atendimentos)" radius={[4, 4, 0, 0]} />
                                    <Bar dataKey="vendas" fill="var(--color-vendas)" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </ChartContainer>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader><CardTitle className="font-headline">Ranking de Desempenho</CardTitle><CardDescription>Análise consolidada por vendedor(a).</CardDescription></CardHeader>
                        <CardContent>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <SortableHeader tKey="salesperson" label="Vendedor(a)" />
                                        <SortableHeader tKey="totalAttendances" label="Atend." className="text-right" />
                                        <SortableHeader tKey="salesCount" label="Vendas" className="text-right" />
                                        <SortableHeader tKey="conversionRate" label="Conversão" className="text-right" />
                                        <SortableHeader tKey="totalRevenue" label="Receita" className="text-right" />
                                        <SortableHeader tKey="averageTicket" label="Ticket" className="text-right" />
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {sortedDisplayData.length > 0 ? sortedDisplayData.map(item => (
                                        <TableRow key={item.salesperson}>
                                            <TableCell className="font-medium">{item.salesperson}</TableCell>
                                            <TableCell className="text-right">{item.totalAttendances}</TableCell>
                                            <TableCell className="text-right">{item.salesCount}</TableCell>
                                            <TableCell className="text-right font-bold text-primary">{(item.conversionRate * 100).toFixed(1)}%</TableCell>
                                            <TableCell className="text-right font-bold text-accent">{item.totalRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</TableCell>
                                            <TableCell className="text-right">{item.averageTicket.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</TableCell>
                                        </TableRow>
                                    )) : <TableRow><TableCell colSpan={6} className="h-24 text-center">Nenhum dado para esta seleção.</TableCell></TableRow>}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </div>
                <div className="lg:col-span-2">
                    {(isAiLoading && consolidatedData.length > 0) && (
                      <Card><CardHeader><CardTitle className="flex items-center gap-2 font-headline"><Sparkles className="h-6 w-6 text-primary animate-pulse" />Analisando Insights...</CardTitle><CardDescription>A IA está preparando um resumo para você.</CardDescription></CardHeader>
                        <CardContent className="space-y-4"><div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div><div className="space-y-2 pt-4"><Skeleton className="h-4 w-32 mb-2" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-full" /></div><div className="space-y-2 pt-4"><Skeleton className="h-4 w-32 mb-2" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-full" /></div></CardContent>
                      </Card>)}
                    {aiSummary && !isAiLoading && (
                      <Card className="animate-in fade-in-50 sticky top-24">
                         <CardHeader><CardTitle className="flex items-center gap-2 font-headline"><Sparkles className="h-6 w-6 text-primary" />Insights com IA</CardTitle></CardHeader>
                         <CardContent className="space-y-6 text-sm text-foreground/90">
                            <div><h3 className="font-semibold text-base mb-2 text-foreground">Resumo Geral</h3><p className="leading-relaxed">{aiSummary.summary}</p></div>
                            <div><h3 className="font-semibold flex items-center gap-2 mb-2 text-foreground"><TrendingUp className="h-5 w-5 text-accent"/>Destaques</h3><ul className="list-disc pl-5 space-y-2">{aiSummary.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul></div>
                            <div><h3 className="font-semibold flex items-center gap-2 mb-2 text-foreground"><CheckCircle className="h-5 w-5 text-green-600"/>Recomendações</h3><ul className="list-disc pl-5 space-y-2">{aiSummary.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
                            {aiSummary.individualHighlights && aiSummary.individualHighlights.length > 0 && (
                                <div>
                                    <h3 className="font-semibold flex items-center gap-2 mb-2 text-foreground"><Users className="h-5 w-5 text-primary"/>Destaques Individuais</h3>
                                    <div className="space-y-4 pt-2">
                                        {aiSummary.individualHighlights.map((item, index) => (
                                            <div key={index} className="border-t border-border/50 pt-3 first:border-t-0 first:pt-0">
                                                <p className="font-semibold text-foreground">{item.salesperson}</p>
                                                <p className="text-sm mt-1 text-foreground/80">
                                                    {item.highlight}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                         </CardContent>
                      </Card>)}
                     {!aiSummary && !isAiLoading && loadedSalesFiles.length === 0 && loadedAttendanceFiles.length > 0 && (
                        <Card className="animate-in fade-in-50 sticky top-24">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 font-headline">
                                    <DollarSign className="h-6 w-6 text-amber-500" />Próximo Passo
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-muted-foreground">Você carregou os dados de atendimento. Agora, <span className="font-semibold text-primary">importe o arquivo de vendas (PDV)</span> para habilitar a análise de conversão e os insights completos da IA.</p>
                            </CardContent>
                        </Card>
                     )}
                     {!aiSummary && !isAiLoading && loadedAttendanceFiles.length === 0 && loadedSalesFiles.length > 0 && (
                        <Card className="animate-in fade-in-50 sticky top-24">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 font-headline">
                                    <Users className="h-6 w-6 text-amber-500" />Próximo Passo
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-muted-foreground">Você carregou os dados de atendimento. Agora, <span className="font-semibold text-primary">importe o arquivo de atendimento</span> para habilitar a análise de conversão e os insights completos da IA.</p>
                            </CardContent>
                        </Card>
                     )}
                </div>
            </div>
        </div>
        )}
      </main>
    </div>
  );
}
