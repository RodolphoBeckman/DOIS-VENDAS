"use client";

import { useState, useMemo, useCallback } from 'react';
import { summarizeSalesData, type SalesSummaryOutput } from '@/ai/flows/sales-summary-flow';
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, BarChart as BarChartIcon, Users, Target, Calendar, X, FileText, Loader2, Sparkles, Zap, TrendingUp, CheckCircle } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

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

export default function SalesAnalyzer() {
  const [data, setData] = useState<SalespersonPerformance[]>([]);
  const [dateRange, setDateRange] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(Date.now());
  const [aiSummary, setAiSummary] = useState<SalesSummaryOutput | null>(null);
  const { toast } = useToast();

  const [selectedSalesperson, setSelectedSalesperson] = useState<string>('all');

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        setAiSummary(null);
        const text = e.target?.result as string;
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        
        if (lines.length < 4) {
          throw new Error("Invalid file format. Expected at least a date range, two header rows, and one data row.");
        }
        
        setDateRange(lines[0]);

        const rawHourHeaders = lines[1].split(',');
        let lastHourHeader = '';
        const hourHeaders = rawHourHeaders.map(h => {
            const trimmed = h.trim();
            if (trimmed) {
                lastHourHeader = trimmed;
                return trimmed;
            }
            return lastHourHeader;
        });

        const metricHeaders = lines[2].split(',').map(h => h.trim().toLowerCase());

        if (!metricHeaders[0].startsWith('vendedor')) {
          throw new Error("Invalid header format. First column of second header row must be 'Vendedor'.");
        }

        const columns: Array<{ hour: number, type: 'attendances' | 'potentials' } | null> = [];
        for (let i = 1; i < hourHeaders.length; i++) {
          const hourHeader = hourHeaders[i];
          const metricHeader = metricHeaders[i];
          
          if (hourHeader.toLowerCase().includes('total')) {
            columns.push(null);
            continue;
          }

          const hourMatch = hourHeader.match(/(\d{2})h/);
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
          const values = row.split(',').map(v => v.trim());
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
            throw new Error("No valid data found in the file.");
        }

        setData(parsedData);
        setSelectedSalesperson('all');
        toast({
          title: "File Uploaded Successfully",
          description: `Found data for ${parsedData.length} salespeople. Generating AI insights...`,
        });

        setIsAiLoading(true);
        const rawCsvForAI = lines.join('\n');
        summarizeSalesData({ csvData: rawCsvForAI, dateRange: lines[0] })
          .then(summary => {
            setAiSummary(summary);
          })
          .catch(aiError => {
            console.error("AI analysis failed:", aiError);
            toast({
              variant: "destructive",
              title: "AI Analysis Failed",
              description: "The AI could not generate insights for this data.",
            });
          })
          .finally(() => {
            setIsAiLoading(false);
          });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "An unknown error occurred during parsing.";
        toast({
          variant: "destructive",
          title: "Upload Failed",
          description: errorMsg,
        });
        setData([]);
      } finally {
        setIsLoading(false);
      }
    };
    reader.onerror = () => {
      setIsLoading(false);
      toast({
        variant: "destructive",
        title: "File Read Error",
        description: "Could not read the selected file.",
      });
    };
    reader.readAsText(file, 'UTF-8');
  }, [toast]);

  const resetData = useCallback(() => {
    setData([]);
    setDateRange("");
    setSelectedSalesperson('all');
    setAiSummary(null);
    setFileInputKey(Date.now());
  }, []);

  const uniqueSalespeople = useMemo(() => ['all', ...data.map(d => d.salesperson).sort()], [data]);

  const filteredData = useMemo(() => {
    if (selectedSalesperson === 'all') return data;
    return data.filter(d => d.salesperson === selectedSalesperson);
  }, [data, selectedSalesperson]);
  
  const totalAttendances = useMemo(() => filteredData.reduce((sum, p) => sum + p.totalAttendances, 0), [filteredData]);
  const totalPotentials = useMemo(() => filteredData.reduce((sum, p) => sum + p.totalPotentials, 0), [filteredData]);
  const opportunityRatio = useMemo(() => totalAttendances > 0 ? (totalPotentials / totalAttendances) : 0, [totalAttendances, totalPotentials]);

  const hourlyTotals = useMemo(() => {
    const totals = new Map<number, { attendances: number, potentials: number }>();
    filteredData.forEach(person => {
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
  }, [filteredData]);

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4 animate-in fade-in-50">
        <Card className="w-full max-w-lg p-6 text-center shadow-2xl">
          <CardHeader>
            <div className="mx-auto bg-primary/10 p-4 rounded-full w-fit">
              <FileText className="w-10 h-10 text-primary" />
            </div>
            <CardTitle className="font-headline text-4xl mt-4">Sales Insights Analyzer</CardTitle>
            <CardDescription className="text-lg">Get AI-powered insights from your daily sales summary CSV</CardDescription>
          </CardHeader>
          <CardContent>
            <label htmlFor="file-upload" className="cursor-pointer group">
              <div className="border-2 border-dashed border-border rounded-lg p-10 flex flex-col items-center justify-center hover:border-primary hover:bg-primary/5 transition-colors duration-300">
                <UploadCloud className="w-10 h-10 text-muted-foreground group-hover:text-primary transition-colors" />
                <p className="mt-4 text-base text-muted-foreground">
                  <span className="font-semibold text-primary">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-muted-foreground mt-1">CSV file with sales summary</p>
              </div>
              <input key={fileInputKey} id="file-upload" type="file" className="hidden" accept=".csv" onChange={handleFileUpload} disabled={isLoading} />
            </label>
            {isLoading && (
              <div className="mt-4 flex items-center justify-center text-primary">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                <span>Processing...</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/20 animate-in fade-in-50">
      <header className="sticky top-0 z-30 bg-background/80 backdrop-blur-sm border-b">
        <div className="container mx-auto flex items-center justify-between p-4">
          <h1 className="font-headline text-2xl flex items-center gap-2">
            <BarChartIcon className="text-primary" />
            <span>Sales Insights</span>
          </h1>
          <Button variant="outline" size="sm" onClick={resetData}>
            <X className="mr-2 h-4 w-4" /> Upload New File
          </Button>
        </div>
      </header>
      
      <main className="container mx-auto p-4 space-y-6">
        <div className="flex flex-col sm:flex-row gap-4 justify-between">
            <div className="flex-1">
                <Label htmlFor="salesperson-filter">Filter by Salesperson</Label>
                <Select onValueChange={setSelectedSalesperson} value={selectedSalesperson}>
                    <SelectTrigger id="salesperson-filter" className="w-full sm:w-[250px]">
                    <SelectValue placeholder="Select a salesperson" />
                    </SelectTrigger>
                    <SelectContent>
                    {uniqueSalespeople.map(person => <SelectItem key={person} value={person}>{person === 'all' ? 'All Salespeople' : person}</SelectItem>)}
                    </SelectContent>
                </Select>
            </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Attendances</CardTitle>
                    <Users className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{totalAttendances}</div>
                    <p className="text-xs text-muted-foreground">in the selected period/person</p>
                </CardContent>
            </Card>
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Total Potentials</CardTitle>
                    <Target className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{totalPotentials}</div>
                    <p className="text-xs text-muted-foreground">new potential clients</p>
                </CardContent>
            </Card>
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Opportunity Ratio</CardTitle>
                    <Zap className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-2xl font-bold">{opportunityRatio.toFixed(2)}</div>
                    <p className="text-xs text-muted-foreground">Opportunities per attendance</p>
                </CardContent>
            </Card>
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Date Range</CardTitle>
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                    <div className="text-xl font-bold">{dateRange}</div>
                    <p className="text-xs text-muted-foreground">Period from the uploaded file</p>
                </CardContent>
            </Card>
        </div>
        
        {isAiLoading && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-headline">
                <Sparkles className="h-6 w-6 text-primary" />
                AI-Powered Insights
              </CardTitle>
              <CardDescription>Our AI is analyzing your data to find key trends and recommendations...</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-[90%]" />
              <div className="space-y-2 pt-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            </CardContent>
          </Card>
        )}

        {aiSummary && !isAiLoading && (
          <Card className="animate-in fade-in-50">
             <CardHeader>
                <CardTitle className="flex items-center gap-2 font-headline">
                  <Sparkles className="h-6 w-6 text-primary" />
                  AI-Powered Insights
                </CardTitle>
             </CardHeader>
             <CardContent className="space-y-4 text-sm">
                <p className="text-base leading-relaxed">{aiSummary.summary}</p>
                <div className="grid md:grid-cols-2 gap-6 pt-4">
                    <div>
                        <h3 className="font-semibold flex items-center gap-2 mb-2"><TrendingUp className="h-5 w-5"/>Highlights</h3>
                        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">{aiSummary.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
                    </div>
                    <div>
                        <h3 className="font-semibold flex items-center gap-2 mb-2"><CheckCircle className="h-5 w-5"/>Recommendations</h3>
                        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">{aiSummary.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
                    </div>
                </div>
             </CardContent>
          </Card>
        )}

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
            <Card className="lg:col-span-4">
                <CardHeader>
                    <CardTitle className="font-headline">Hourly Performance</CardTitle>
                    <CardDescription>Attendances vs Potentials throughout the day.</CardDescription>
                </CardHeader>
                <CardContent className="pl-2">
                    <ChartContainer config={{
                      attendances: { label: 'Attendances', color: 'hsl(var(--primary))' },
                      potentials: { label: 'Potentials', color: 'hsl(var(--accent))' },
                    }} className="h-[300px] w-full">
                        <BarChart data={hourlyTotals} accessibilityLayer>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="name" tickLine={false} tickMargin={10} axisLine={false} />
                        <YAxis />
                        <Tooltip cursor={{fill: 'hsl(var(--muted))'}} content={<ChartTooltipContent />} />
                        <Legend />
                        <Bar dataKey="attendances" fill="var(--color-attendances)" radius={4} />
                        <Bar dataKey="potentials" fill="var(--color-potentials)" radius={4} />
                        </BarChart>
                    </ChartContainer>
                </CardContent>
            </Card>
            <Card className="lg:col-span-3">
                <CardHeader>
                    <CardTitle className="font-headline">Salespeople Ranking</CardTitle>
                    <CardDescription>Based on total attendances.</CardDescription>
                </CardHeader>
                <CardContent>
                    <ScrollArea className="h-[300px]">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                <TableHead>Salesperson</TableHead>
                                <TableHead className="text-right">Attendances</TableHead>
                                <TableHead className="text-right">Potentials</TableHead>
                                <TableHead className="text-right">Opp. Ratio</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredData.length > 0 ? filteredData
                                .sort((a,b) => b.totalAttendances - a.totalAttendances)
                                .map(item => (
                                    <TableRow key={item.salesperson}>
                                        <TableCell className="font-medium">{item.salesperson}</TableCell>
                                        <TableCell className="text-right font-bold text-primary">{item.totalAttendances}</TableCell>
                                        <TableCell className="text-right">{item.totalPotentials}</TableCell>
                                        <TableCell className="text-right">{(item.totalAttendances > 0 ? item.totalPotentials / item.totalAttendances : 0).toFixed(2)}</TableCell>
                                    </TableRow>
                                )) : (
                                    <TableRow>
                                        <TableCell colSpan={4} className="h-24 text-center">No data for this selection.</TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </ScrollArea>
                </CardContent>
            </Card>
        </div>
      </main>
    </div>
  );
}
