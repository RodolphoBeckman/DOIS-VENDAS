
"use client";

import { useState, useMemo, useCallback, useEffect } from 'react';
import type { DateRange } from "react-day-picker";
import { format } from "date-fns";
import { ptBR } from 'date-fns/locale';
import { parse as parseDate, isWithinInterval, startOfDay, endOfDay } from 'date-fns';

import { summarizeSalesData, type SalesSummaryOutput } from '@/ai/flows/sales-summary-flow';
import { useToast } from "@/hooks/use-toast";
import { 
    UploadCloud, BarChart as BarChartIcon, Users, Target, Calendar as CalendarIcon, X, Loader2, Sparkles, Zap, 
    TrendingUp, CheckCircle, DollarSign, HelpCircle, Cog
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';

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


export default function SalesAnalyzer() {
  const [loadedAttendanceFiles, setLoadedAttendanceFiles] = useState<LoadedAttendanceFile[]>([]);
  const [loadedSalesFiles, setLoadedSalesFiles] = useState<LoadedSalesFile[]>([]);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [filterDateRange, setFilterDateRange] = useState<DateRange | undefined>();
  
  const [isLoading, setIsLoading] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  
  const [attendanceInputKey, setAttendanceInputKey] = useState(Date.now());
  const [salesInputKey, setSalesInputKey] = useState(Date.now());
  
  const [aiSummary, setAiSummary] = useState<SalesSummaryOutput | null>(null);
  const { toast } = useToast();

  const [selectedSalesperson, setSelectedSalesperson] = useState<string>('all');

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
    const attendanceFilesToProcess = filterDateRange?.from
      ? loadedAttendanceFiles.filter(file => {
          const fileInterval = { start: file.dateRange.start, end: file.dateRange.end };
          const filterInterval = { start: startOfDay(filterDateRange.from!), end: endOfDay(filterDateRange.to ?? filterDateRange.from!) };
          return isWithinInterval(fileInterval.start, filterInterval) || isWithinInterval(fileInterval.end, filterInterval) || 
                 (fileInterval.start < filterInterval.start && fileInterval.end > filterInterval.end);
        })
      : loadedAttendanceFiles;

    const salesFilesToProcess = loadedSalesFiles; // Sales files are not filtered by date for now

    if (attendanceFilesToProcess.length === 0 && salesFilesToProcess.length === 0) {
        return { consolidatedData: [], combinedAttendanceCsv: '', combinedSalesCsv: '', displayDateRange: 'Nenhum dado para o período' };
    }
    
    const mergedPerformances = mergeAttendanceData(attendanceFilesToProcess.map(f => f.parsedData));
    const mergedSales = mergeSalesData(salesFilesToProcess.map(f => f.parsedData));
    
    const allSalespeople = [...new Set([...mergedPerformances.map(p => p.salesperson), ...mergedSales.map(s => s.salesperson)])];

    const consolidatedData: ConsolidatedData[] = allSalespeople.map(name => {
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
    
    const combinedAttendanceCsv = attendanceFilesToProcess.map(f => f.content).join('\n\n');
    const combinedSalesCsv = salesFilesToProcess.map(f => f.content).join('\n\n');

    const dateRanges = attendanceFilesToProcess.map(f => f.content.split('\n')[0].trim());
    const uniqueDateRanges = [...new Set(dateRanges)];
    const displayDateRange = uniqueDateRanges.join(' & ') || 'Todos os Períodos Carregados';

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
  
  const { consolidatedData } = activeData;

  const uniqueSalespeople = useMemo(() => ['all', ...consolidatedData.map(d => d.salesperson).sort()], [consolidatedData]);

  const filteredDataBySalesperson = useMemo(() => {
    if (selectedSalesperson === 'all') return consolidatedData;
    return consolidatedData.filter(d => d.salesperson === selectedSalesperson);
  }, [consolidatedData, selectedSalesperson]);
  
  const totalAttendances = useMemo(() => filteredDataBySalesperson.reduce((sum, p) => sum + p.totalAttendances, 0), [filteredDataBySalesperson]);
  const totalSalesCount = useMemo(() => filteredDataBySalesperson.reduce((sum, p) => sum + p.salesCount, 0), [filteredDataBySalesperson]);
  const totalRevenue = useMemo(() => filteredDataBySalesperson.reduce((sum, p) => sum + p.totalRevenue, 0), [filteredDataBySalesperson]);
  const averageConversionRate = useMemo(() => totalAttendances > 0 ? (totalSalesCount / totalAttendances) : 0, [totalAttendances, totalSalesCount]);

  const hourlyTotals = useMemo(() => {
    const totals = new Map<number, { attendances: number, potentials: number }>();
    filteredDataBySalesperson.forEach(person => {
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
  }, [filteredDataBySalesperson]);
  
  return (
    <div className="min-h-screen animate-in fade-in-50 bg-secondary/50">
      <header className="sticky top-0 z-30 bg-card shadow-sm">
        <div className="container mx-auto flex items-center justify-between p-4">
          <h1 className="font-headline text-2xl flex items-center gap-2 text-foreground">
            <BarChartIcon className="text-primary" />
            <span>Analisador de Vendas</span>
          </h1>
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
      </header>
      
      <main className="container mx-auto p-4 md:p-6 space-y-6">
        {isLoading && (<div className="flex items-center justify-center text-primary"><Loader2 className="mr-2 h-5 w-5 animate-spin" /><span>Processando arquivo...</span></div>)}
        {(loadedAttendanceFiles.length === 0 && loadedSalesFiles.length === 0) && !isLoading && (
            <Card className="w-full p-6 text-center shadow-lg border-0 bg-card mt-6">
                <CardHeader>
                    <div className="mx-auto bg-primary/10 p-4 rounded-full w-fit"><HelpCircle className="w-10 h-10 text-primary" /></div>
                    <CardTitle className="font-headline text-3xl mt-4">Bem-vindo ao Analisador de Vendas</CardTitle>
                    <CardDescription className="text-md text-muted-foreground max-w-xl mx-auto">Para começar, clique em <span className="font-semibold text-primary">"Configurar e Importar"</span> e carregue seus arquivos de atendimento e vendas.</CardDescription>
                </CardHeader>
            </Card>
        )}
        {(loadedAttendanceFiles.length > 0 || loadedSalesFiles.length > 0) && (
        <div className="animate-in fade-in-50">
            <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center mb-6">
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
                        <CardHeader><CardTitle className="font-headline">Ranking de Desempenho</CardTitle><CardDescription>Análise consolidada por vendedor(a).</CardDescription></CardHeader>
                        <CardContent>
                            <ScrollArea className="h-[300px]">
                                <Table>
                                    <TableHeader><TableRow><TableHead>Vendedor(a)</TableHead><TableHead className="text-right">Atend.</TableHead><TableHead className="text-right">Vendas</TableHead><TableHead className="text-right">Conversão</TableHead><TableHead className="text-right">Receita</TableHead><TableHead className="text-right">Ticket Médio</TableHead></TableRow></TableHeader>
                                    <TableBody>
                                        {filteredDataBySalesperson.length > 0 ? filteredDataBySalesperson.sort((a,b) => b.totalRevenue - a.totalRevenue).map(item => (
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
                            </ScrollArea>
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
                         <CardContent className="space-y-6 text-sm">
                            <div><h3 className="font-semibold text-base mb-2">Resumo Geral</h3><p className="leading-relaxed text-muted-foreground">{aiSummary.summary}</p></div>
                            <div><h3 className="font-semibold flex items-center gap-2 mb-2"><TrendingUp className="h-5 w-5 text-accent"/>Destaques</h3><ul className="list-disc pl-5 space-y-2 text-muted-foreground">{aiSummary.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul></div>
                            <div><h3 className="font-semibold flex items-center gap-2 mb-2"><CheckCircle className="h-5 w-5 text-green-600"/>Recomendações</h3><ul className="list-disc pl-5 space-y-2 text-muted-foreground">{aiSummary.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
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
                                <p className="text-muted-foreground">Você carregou os dados de vendas. Agora, <span className="font-semibold text-primary">importe o arquivo de atendimento</span> para habilitar a análise de conversão e os insights completos da IA.</p>
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
