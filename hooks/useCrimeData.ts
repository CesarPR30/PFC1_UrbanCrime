import { useState, useEffect } from "react";
import Papa from "papaparse";

export interface CrimeRecord {
  date: string;
  type: string;
  lat: number;
  lng: number;
}

export function useCrimeData(csvPath: string) {
  const [data, setData] = useState<CrimeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Papa.parse<CrimeRecord>(csvPath, {
      download: true,
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (results) => {
        setData(results.data);
        setLoading(false);
      },
      error: (err) => {
        setError(err.message);
        setLoading(false);
      },
    });
  }, [csvPath]);

  return { data, loading, error };
}
