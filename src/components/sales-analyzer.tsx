
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

type LoadedFile = {
    name: string;
    content: string;
    dateRange: { start: Date; end: Date };
    parsedData: SalespersonPerformance[];
};

const parseDateRangeFromString = (rangeStr: string): { start: Date, end: Date } | null => {
    try {
        const parts = rangeStr.split('-').map(p => p.trim());
        if (parts.length !== 2) return null;
        const [startStr, endStr] = parts;
        const start = startOfDay(parseDate(startStr, 'yyyy/MM/dd', new Date()));
        const end = endOfDay(parseDate(endStr, 'yyyy/MM/dd', new Date()));

        if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

        return { start, end };
    } catch (e) {
        console.error("Erro ao parsear o período:", e);
        return null;
    }
};

const parseAttendanceCsv = (csvText: string): { data: SalespersonPerformance[], dateRange: { start: Date, end: Date } | null } => {
    const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
    
    if (lines.length < 4) {
      throw new Error("Formato de arquivo inválido. É esperado ao menos um período, duas linhas de cabeçalho e uma linha de dados.");
    }

    const dateRange = parseDateRangeFromString(lines[0]);
    
    const rawHourHeaders = lines[1].split(';');
    let lastHourHeader = '';
    const hourHeaders = rawHourHeaders.map(h => {
        const trimmed = h.trim();
        if (trimmed) {
            lastHourHeader = trimmed;
            return trimmed;
        }
        return lastHourHeader;
    });

    const metricHeaders = lines[2].split(';').map(h => h.trim().toLowerCase());

    if (!metricHeaders[0].startsWith('vendedor')) {
      throw new Error("Formato de cabeçalho inválido. A primeira coluna da segunda linha de cabeçalho deve ser 'Vendedor'.");
    }

    const columns: Array<{ hour: number, type: 'attendances' | 'potentials' } | null> = [];
    for (let i = 1; i < hourHeaders.length; i++) {
      const hourHeader = hourHeaders[i];
      const metricHeader = metricHeaders[i];
      
      if (hourHeader.toLowerCase().includes('total')) {
        columns.push(null);
        continue;
      }

      const hourMatch = hourHeader.match(/(\d{1,2})h/);
      if (!hourMatch) {
        columns.push(null);
        continue;
      }
      
      const hour = parseInt(hourMatch[1], 10);
      if (metricHeader === 'at.') {
        columns.push({ hour, type: 'attendances' });
      } else if (metricHeader === 'pot.') {
        columns.push({ hour, type: 'potentials' });
      } else {
        columns.push(null);
      }
    }
    
    const dataRows = lines.slice(3);
    const parsedData: SalespersonPerformance[] = [];

    for (const row of dataRows) {
      const values = row.split(';').map(v => v.trim());
      const salesperson = values[0];
      if (salesperson.toLowerCase() === 'total' || !salesperson) continue;

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

      parsedData.push({
        salesperson,
        hourly,
        totalAttendances,
        totalPotentials
      });
    }
    
    if (parsedData.length === 0) {
        throw new Error("Nenhum dado válido encontrado no arquivo.");
    }
    return { data: parsedData, dateRange };
}

const mergeAttendanceData = (datasets: SalespersonPerformance[][]): SalespersonPerformance[] => {
    const mergedMap = new Map<string, SalespersonPerformance>();

    for (const dataset of datasets) {
        for (const newPerson of dataset) {
            if (mergedMap.has(newPerson.salesperson)) {
                const existingPerson = mergedMap.get(newPerson.salesperson)!;
                const hourlyMap = new Map<number, HourlyData>();
                for (const h of existingPerson.hourly) {
                    hourlyMap.set(h.hour, {...h});
                }

                for (const newHour of newPerson.hourly) {
                    if (hourlyMap.has(newHour.hour)) {
                        const existingHour = hourlyMap.get(newHour.hour)!;
                        existingHour.attendances += newHour.attendances;
                        existingHour.potentials += newHour.potentials;
                    } else {
                        hourlyMap.set(newHour.hour, {...newHour});
                    }
                }
                existingPerson.hourly = Array.from(hourlyMap.values()).sort((a,b) => a.hour - b.hour);
                existingPerson.totalAttendances = existingPerson.hourly.reduce((sum, h) => sum + h.attendances, 0);
                existingPerson.totalPotentials = existingPerson.hourly.reduce((sum, h) => sum + h.potentials, 0);
            } else {
                mergedMap.set(newPerson.salesperson, JSON.parse(JSON.stringify(newPerson)));
            }
        }
    }
    return Array.from(mergedMap.values());
};

export default function SalesAnalyzer() {
  const [loadedFiles, setLoadedFiles] = useState<LoadedFile[]>([]);
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

    if (loadedFiles.some(f => f.name === file.name)) {
        toast({
            variant: "destructive",
            title: "Arquivo Duplicado",
            description: `O arquivo "${file.name}" já foi carregado.`,
        });
        setAttendanceInputKey(Date.now());
        return;
    }

    if (type === 'sales') {
        toast({
            title: "Funcionalidade em Desenvolvimento",
            description: "A importação de vendas será implementada em breve, assim que o formato do arquivo for fornecido.",
        });
        setSalesInputKey(Date.now());
        return;
    }

    setIsLoading(true);
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const { data: newParsedData, dateRange } = parseAttendanceCsv(text);
        
        if (!dateRange) {
            throw new Error("Não foi possível encontrar um período de datas válido na primeira linha do arquivo.");
        }

        const newFile: LoadedFile = {
            name: file.name,
            content: text,
            dateRange: dateRange,
            parsedData: newParsedData
        };

        setLoadedFiles(currentFiles => [...currentFiles, newFile]);

        toast({
          title: "Arquivo de Atendimento Carregado",
          description: `Dados de "${file.name}" foram adicionados com sucesso.`,
        });

      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Ocorreu um erro desconhecido durante o processamento.";
        toast({
          variant: "destructive",
          title: "Falha no Upload",
          description: errorMsg,
        });
      } finally {
        setIsLoading(false);
        setAttendanceInputKey(Date.now());
      }
    };
    reader.onerror = () => {
      setIsLoading(false);
      toast({
        variant: "destructive",
        title: "Erro de Leitura de Arquivo",
        description: "Não foi possível ler o arquivo selecionado.",
      });
    };
    reader.readAsText(file, 'UTF-8');
  }, [toast, loadedFiles]);
  
  const activeData = useMemo(() => {
    const filesToProcess = filterDateRange?.from
      ? loadedFiles.filter(file => {
          const fileInterval = { start: file.dateRange.start, end: file.dateRange.end };
          const filterInterval = { start: startOfDay(filterDateRange.from!), end: endOfDay(filterDateRange.to ?? filterDateRange.from!) };
          return isWithinInterval(fileInterval.start, filterInterval) || isWithinInterval(fileInterval.end, filterInterval) || 
                 (fileInterval.start < filterInterval.start && fileInterval.end > filterInterval.end);
        })
      : loadedFiles;

    if (filesToProcess.length === 0) {
        return {
            mergedPerformances: [],
            combinedCsvForAI: '',
            displayDateRange: 'Nenhum dado para o período selecionado'
        };
    }
    
    const mergedPerformances = mergeAttendanceData(filesToProcess.map(f => f.parsedData));
    
    const firstFileHeader = filesToProcess.length > 0 ? filesToProcess[0].content.split('\n').slice(0, 3).join('\n') : '';
    const combinedRows = filesToProcess.map(f => f.content.split('\n').slice(3).join('\n')).join('\n');
    const combinedCsvForAI = `${firstFileHeader}\n${combinedRows}`;
    
    const dateRanges = filesToProcess.map(f => f.content.split('\n')[0].trim());
    const uniqueDateRanges = [...new Set(dateRanges)];
    const displayDateRange = uniqueDateRanges.join(' & ');

    return { mergedPerformances, combinedCsvForAI, displayDateRange };

  }, [loadedFiles, filterDateRange]);


  useEffect(() => {
    if (!activeData.combinedCsvForAI) {
        setAiSummary(null);
        return;
    }
    
    setIsAiLoading(true);

    summarizeSalesData({ csvData: activeData.combinedCsvForAI, dateRange: activeData.displayDateRange })
      .then(summary => {
        setAiSummary(summary);
      })
      .catch(aiError => {
        console.error("Falha na análise de IA:", aiError);
        toast({
          variant: "destructive",
          title: "Falha na Análise de IA",
          description: "A IA não conseguiu gerar insights para estes dados.",
        });
        setAiSummary(null);
      })
      .finally(() => {
        setIsAiLoading(false);
      });
  }, [activeData.combinedCsvForAI, activeData.displayDateRange, toast]);

  const resetData = useCallback(() => {
    setLoadedFiles([]);
    setSelectedSalesperson('all');
    setAiSummary(null);
    setFilterDateRange(undefined);
    setAttendanceInputKey(Date.now());
    setSalesInputKey(Date.now());
    setIsImportOpen(false);
    toast({
        title: "Dados Resetados",
        description: "Todos os dados foram limpos. Você pode começar uma nova análise.",
    });
  }, [toast]);
  
  const { mergedPerformances } = activeData;

  const uniqueSalespeople = useMemo(() => ['all', ...mergedPerformances.map(d => d.salesperson).sort()], [mergedPerformances]);

  const filteredDataBySalesperson = useMemo(() => {
    if (selectedSalesperson === 'all') return mergedPerformances;
    return mergedPerformances.filter(d => d.salesperson === selectedSalesperson);
  }, [mergedPerformances, selectedSalesperson]);
  
  const totalAttendances = useMemo(() => filteredDataBySalesperson.reduce((sum, p) => sum + p.totalAttendances, 0), [filteredDataBySalesperson]);
  const totalPotentials = useMemo(() => filteredDataBySalesperson.reduce((sum, p) => sum + p.totalPotentials, 0), [filteredDataBySalesperson]);
  const opportunityRatio = useMemo(() => totalAttendances > 0 ? (totalPotentials / totalAttendances) : 0, [totalAttendances, totalPotentials]);

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
        .map(([hour, data]) => ({
            name: `${String(hour).padStart(2, '0')}:00`,
            attendances: data.attendances,
            potentials: data.potentials,
        }))
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
                    <Button variant="outline">
                        <Cog className="mr-2 h-4 w-4" /> Configurar e Importar
                    </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[800px]">
                    <DialogHeader>
                        <DialogTitle className="font-headline text-2xl">Importar Dados</DialogTitle>
                        <DialogDescription>
                            Carregue seus arquivos CSV para análise. Os dados importados são acumulativos e podem ser filtrados por período no painel principal.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid md:grid-cols-2 gap-6 py-4">
                        <div>
                            <Label htmlFor="attendance-upload" className="font-semibold text-base mb-2 block">1. Atendimentos e Potenciais</Label>
                            <label htmlFor="attendance-upload" className="cursor-pointer group">
                                <div className="border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center hover:border-primary hover:bg-primary/5 transition-colors duration-300">
                                    <UploadCloud className="w-10 h-10 text-muted-foreground group-hover:text-primary transition-colors" />
                                    <p className="mt-4 text-sm text-muted-foreground">
                                    <span className="font-semibold text-primary">Clique para carregar</span> ou arraste
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-1">Arquivo CSV com atendimentos</p>
                                </div>
                                <input key={attendanceInputKey} id="attendance-upload" type="file" className="hidden" accept=".csv,.txt" onChange={(e) => handleFileUpload(e, 'attendance')} disabled={isLoading} />
                            </label>
                        </div>
                        <div>
                            <Label htmlFor="sales-upload" className="font-semibold text-base mb-2 block">2. Vendas Realizadas</Label>
                            <label htmlFor="sales-upload" className="cursor-pointer group">
                                <div className="border-2 border-dashed border-border rounded-lg p-8 flex flex-col items-center justify-center hover:border-primary hover:bg-primary/5 transition-colors duration-300 bg-muted/25 opacity-70">
                                    <DollarSign className="w-10 h-10 text-muted-foreground group-hover:text-primary transition-colors" />
                                    <p className="mt-4 text-sm text-muted-foreground">
                                    <span className="font-semibold text-primary">Clique para carregar</span> ou arraste
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-1">Arquivo CSV com vendas (em breve)</p>
                                </div>
                                <input key={salesInputKey} id="sales-upload" type="file" className="hidden" accept=".csv,.txt" onChange={(e) => handleFileUpload(e, 'sales')} />
                            </label>
                        </div>
                    </div>
                    {loadedFiles.length > 0 && (
                        <div className="mt-4">
                            <h3 className="font-semibold mb-2">Arquivos Carregados</h3>
                            <ScrollArea className="h-[100px] border rounded-md p-2">
                                <ul className="space-y-1">
                                    {loadedFiles.map(file => (
                                        <li key={file.name} className="text-sm text-muted-foreground">{file.name}</li>
                                    ))}
                                </ul>
                            </ScrollArea>
                        </div>
                    )}
                    <DialogFooter>
                        {loadedFiles.length > 0 && (
                            <Button variant="destructive" onClick={resetData}>
                                <X className="mr-2 h-4 w-4" /> Limpar Tudo e Recomeçar
                            </Button>
                        )}
                        <Button onClick={() => setIsImportOpen(false)}>Fechar</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
      </header>
      
      <main className="container mx-auto p-4 md:p-6 space-y-6">
        {isLoading && (
            <div className="mt-4 flex items-center justify-center text-primary">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            <span>Processando arquivo...</span>
            </div>
        )}

        {loadedFiles.length === 0 && !isLoading && (
            <Card className="w-full p-6 text-center shadow-lg border-0 bg-card mt-6">
                <CardHeader>
                    <div className="mx-auto bg-primary/10 p-4 rounded-full w-fit">
                        <HelpCircle className="w-10 h-10 text-primary" />
                    </div>
                    <CardTitle className="font-headline text-3xl mt-4">Bem-vindo ao Analisador de Vendas</CardTitle>
                    <CardDescription className="text-md text-muted-foreground max-w-xl mx-auto">
                        Para começar, clique em <span className="font-semibold text-primary">"Configurar e Importar"</span> no canto superior direito e carregue seu primeiro arquivo de atendimentos.
                    </CardDescription>
                </CardHeader>
            </Card>
        )}

        {loadedFiles.length > 0 && (
        <div className="animate-in fade-in-50">
            <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center mb-6">
                <div className="flex-1">
                    <h2 className="text-2xl font-headline text-foreground">Dashboard de Desempenho</h2>
                    <p className="text-muted-foreground">Análise para o período: <span className="font-semibold text-primary">{activeData.displayDateRange}</span></p>
                </div>
                <div className="w-full flex-col md:flex-row flex gap-2">
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button id="date" variant={"outline"} className={cn("w-full md:w-[280px] justify-start text-left font-normal", !filterDateRange && "text-muted-foreground")}>
                                <CalendarIcon className="mr-2 h-4 w-4" />
                                {filterDateRange?.from ? (
                                    filterDateRange.to ? (
                                        <>
                                            {format(filterDateRange.from, "dd/MM/yy", { locale: ptBR })} -{' '}
                                            {format(filterDateRange.to, "dd/MM/yy", { locale: ptBR })}
                                        </>
                                    ) : (
                                        format(filterDateRange.from, "dd/MM/yy", { locale: ptBR })
                                    )
                                ) : (
                                    <span>Filtrar por Período</span>
                                )}
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="end">
                            <Calendar
                                initialFocus
                                mode="range"
                                defaultMonth={filterDateRange?.from}
                                selected={filterDateRange}
                                onSelect={setFilterDateRange}
                                numberOfMonths={2}
                                locale={ptBR}
                            />
                        </PopoverContent>
                    </Popover>
                    <Select onValueChange={setSelectedSalesperson} value={selectedSalesperson}>
                        <SelectTrigger id="salesperson-filter" className="w-full md:w-[250px] bg-card">
                        <SelectValue placeholder="Selecione um(a) vendedor(a)" />
                        </SelectTrigger>
                        <SelectContent>
                        {uniqueSalespeople.map(person => <SelectItem key={person} value={person}>{person === 'all' ? 'Todos os Vendedores' : person}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Total de Atendimentos</CardTitle><Users className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{totalAttendances}</div><p className="text-xs text-muted-foreground truncate">{selectedSalesperson === 'all' ? 'Todos os vendedores' : selectedSalesperson}</p></CardContent></Card>
                <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Total de Potenciais</CardTitle><Target className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{totalPotentials}</div><p className="text-xs text-muted-foreground">novos clientes em potencial</p></CardContent></Card>
                <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Taxa de Oportunidade</CardTitle><Zap className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{opportunityRatio.toFixed(2)}</div><p className="text-xs text-muted-foreground">Potenciais por atendimento</p></CardContent></Card>
                <Card><CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium">Vendedores Ativos</CardTitle><Users className="h-4 w-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-bold">{uniqueSalespeople.length - 1}</div><p className="text-xs text-muted-foreground">Vendedores no período</p></CardContent></Card>
            </div>
            
            <div className="grid gap-6 lg:grid-cols-5 mt-6">
                <div className="lg:col-span-3 space-y-6">
                    <Card>
                        <CardHeader><CardTitle className="font-headline">Desempenho por Hora</CardTitle><CardDescription>Atendimentos vs Potenciais ao longo do dia.</CardDescription></CardHeader>
                        <CardContent className="pl-2">
                            <ChartContainer config={{ attendances: { label: 'Atendimentos', color: 'hsl(var(--chart-1))' }, potentials: { label: 'Potenciais', color: 'hsl(var(--chart-2))' }, }} className="h-[300px] w-full">
                                <BarChart data={hourlyTotals} accessibilityLayer><CartesianGrid vertical={false} /><XAxis dataKey="name" tickLine={false} tickMargin={10} axisLine={false} fontSize={12} /><YAxis tickLine={false} axisLine={false} fontSize={12} /><Tooltip cursor={{fill: 'hsl(var(--muted))'}} content={<ChartTooltipContent />} /><Legend /><Bar dataKey="attendances" fill="var(--color-attendances)" radius={[4, 4, 0, 0]} /><Bar dataKey="potentials" fill="var(--color-potentials)" radius={[4, 4, 0, 0]} /></BarChart>
                            </ChartContainer>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader><CardTitle className="font-headline">Ranking de Vendedores</CardTitle><CardDescription>Baseado no total de atendimentos acumulados.</CardDescription></CardHeader>
                        <CardContent>
                            <ScrollArea className="h-[300px]">
                                <Table>
                                    <TableHeader><TableRow><TableHead className="w-[180px]">Vendedor(a)</TableHead><TableHead className="text-right">Atendimentos</TableHead><TableHead className="text-right">Potenciais</TableHead><TableHead className="text-right">Tx. Oport.</TableHead></TableRow></TableHeader>
                                    <TableBody>
                                        {filteredDataBySalesperson.length > 0 ? filteredDataBySalesperson.sort((a,b) => b.totalAttendances - a.totalAttendances).map(item => (
                                            <TableRow key={item.salesperson}>
                                                <TableCell className="font-medium">{item.salesperson}</TableCell>
                                                <TableCell className="text-right font-bold text-primary">{item.totalAttendances}</TableCell>
                                                <TableCell className="text-right text-accent">{item.totalPotentials}</TableCell>
                                                <TableCell className="text-right">{(item.totalAttendances > 0 ? item.totalPotentials / item.totalAttendances : 0).toFixed(2)}</TableCell>
                                            </TableRow>
                                        )) : <TableRow><TableCell colSpan={4} className="h-24 text-center">Nenhum dado para esta seleção.</TableCell></TableRow>}
                                    </TableBody>
                                </Table>
                            </ScrollArea>
                        </CardContent>
                    </Card>
                </div>
                <div className="lg:col-span-2">
                    {(isAiLoading && mergedPerformances.length > 0) && (
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
                </div>
            </div>
        </div>
        )}
      </main>
    </div>
  );
}
