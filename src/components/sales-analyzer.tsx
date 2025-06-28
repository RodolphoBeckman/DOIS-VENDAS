"use client";

import { useState, useMemo, useCallback } from 'react';
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, BarChart, User, Clock, X, FileText, Loader2 } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";

type Sale = {
  id: string;
  salesperson: string;
  hour: number;
};

export default function SalesAnalyzer() {
  const [data, setData] = useState<Sale[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(Date.now());
  const { toast } = useToast();

  const [selectedSalesperson, setSelectedSalesperson] = useState<string>('all');
  const [selectedHour, setSelectedHour] = useState<string>('all');

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const lines = text.split('\n');
        
        // Check for header
        const header = lines[0].trim().toLowerCase();
        if (header !== 'vendedora,hora' && header !== 'salesperson,hour') {
            throw new Error("Invalid header. Expected 'vendedora,hora' or 'salesperson,hour'.");
        }

        const parsedData: Sale[] = lines
          .slice(1)
          .map((line, index) => {
            if (line.trim() === '') return null;
            const [salesperson, hourStr] = line.split(',');
            if (salesperson && hourStr) {
              const hour = parseInt(hourStr.trim(), 10);
              if (!isNaN(hour) && hour >= 0 && hour <= 23) {
                return { id: `sale-${index}-${Math.random()}`, salesperson: salesperson.trim(), hour };
              }
            }
            return null;
          })
          .filter((item): item is Sale => item !== null);
        
        if (parsedData.length === 0) {
            throw new Error("No valid data found in the file.");
        }

        setData(parsedData);
        toast({
          title: "File Uploaded Successfully",
          description: `Found ${parsedData.length} sales records.`,
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
    reader.readAsText(file);
  }, [toast]);

  const resetData = useCallback(() => {
    setData([]);
    setSelectedSalesperson('all');
    setSelectedHour('all');
    setFileInputKey(Date.now());
  }, []);

  const uniqueSalespeople = useMemo(() => ['all', ...Array.from(new Set(data.map(d => d.salesperson)))], [data]);
  const uniqueHours = useMemo(() => ['all', ...Array.from(new Set(data.map(d => d.hour))).sort((a,b) => a-b)], [data]);

  const filteredData = useMemo(() => {
    return data.filter(d => 
      (selectedSalesperson === 'all' || d.salesperson === selectedSalesperson) &&
      (selectedHour === 'all' || d.hour === parseInt(selectedHour, 10))
    );
  }, [data, selectedSalesperson, selectedHour]);
  
  const aggregatedData = useMemo(() => {
    const counts: { [key: string]: number } = {};
    filteredData.forEach(sale => {
      counts[sale.salesperson] = (counts[sale.salesperson] || 0) + 1;
    });
    return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
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
            <CardDescription className="text-lg">Upload your CSV file to get started</CardDescription>
          </CardHeader>
          <CardContent>
            <label htmlFor="file-upload" className="cursor-pointer group">
              <div className="border-2 border-dashed border-border rounded-lg p-10 flex flex-col items-center justify-center hover:border-primary hover:bg-primary/5 transition-colors duration-300">
                <UploadCloud className="w-10 h-10 text-muted-foreground group-hover:text-primary transition-colors" />
                <p className="mt-4 text-base text-muted-foreground">
                  <span className="font-semibold text-primary">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-muted-foreground mt-1">CSV file with 'vendedora,hora' columns</p>
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
    <div className="min-h-screen animate-in fade-in-50">
      <header className="sticky top-0 z-30 bg-background/80 backdrop-blur-sm border-b">
        <div className="container mx-auto flex items-center justify-between p-4">
          <h1 className="font-headline text-2xl flex items-center gap-2">
            <BarChart className="text-primary" />
            <span>Sales Insights</span>
          </h1>
          <Button variant="outline" size="sm" onClick={resetData}>
            <X className="mr-2 h-4 w-4" /> Upload New File
          </Button>
        </div>
      </header>
      
      <main className="container mx-auto p-4 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
            <Card>
                <CardHeader className="flex-row items-center justify-between">
                    <div>
                        <CardTitle className="font-headline">Sales Data</CardTitle>
                        <CardDescription>
                            Showing {filteredData.length} of {data.length} records.
                        </CardDescription>
                    </div>
                </CardHeader>
                <CardContent>
                    <ScrollArea className="h-[60vh] w-full">
                    <Table>
                        <TableHeader className="sticky top-0 bg-background">
                        <TableRow>
                            <TableHead>Salesperson</TableHead>
                            <TableHead className="text-right">Hour of Attendance</TableHead>
                        </TableRow>
                        </TableHeader>
                        <TableBody>
                        {filteredData.length > 0 ? filteredData.map(sale => (
                            <TableRow key={sale.id}>
                            <TableCell className="font-medium">{sale.salesperson}</TableCell>
                            <TableCell className="text-right">{String(sale.hour).padStart(2, '0')}:00</TableCell>
                            </TableRow>
                        )) : (
                            <TableRow>
                                <TableCell colSpan={2} className="h-24 text-center">No results found for the selected filters.</TableCell>
                            </TableRow>
                        )}
                        </TableBody>
                    </Table>
                    </ScrollArea>
                </CardContent>
            </Card>
        </div>

        <aside className="space-y-6 lg:sticky lg:top-20 self-start">
          <Card>
            <CardHeader>
              <CardTitle className="font-headline">Filters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="salesperson-filter">Salesperson</Label>
                <Select onValueChange={setSelectedSalesperson} value={selectedSalesperson}>
                  <SelectTrigger id="salesperson-filter">
                    <SelectValue placeholder="Select a salesperson" />
                  </SelectTrigger>
                  <SelectContent>
                    {uniqueSalespeople.map(person => <SelectItem key={person} value={person}>{person === 'all' ? 'All Salespeople' : person}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="hour-filter">Hour</Label>
                <Select onValueChange={setSelectedHour} value={selectedHour}>
                  <SelectTrigger id="hour-filter">
                    <SelectValue placeholder="Select an hour" />
                  </SelectTrigger>
                  <SelectContent>
                    {uniqueHours.map(hour => <SelectItem key={String(hour)} value={String(hour)}>{hour === 'all' ? 'All Hours' : `${String(hour).padStart(2, '0')}:00`}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-headline">Summary</CardTitle>
              <CardDescription>Attendances for selection</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-60">
                <div className="space-y-4 pr-4">
                    {aggregatedData.length > 0 ? aggregatedData.map(item => (
                    <div key={item.name} className="flex items-center justify-between animate-in fade-in-50">
                        <p className="flex items-center gap-2 text-sm font-medium"><User className="h-4 w-4 text-muted-foreground" /> {item.name}</p>
                        <p className="font-bold text-lg text-primary">{item.count}</p>
                    </div>
                    )) : (
                         <p className="text-sm text-muted-foreground text-center py-10">No summary for this selection.</p>
                    )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </aside>
      </main>
    </div>
  );
}
