import React, { useState, useCallback, useMemo } from "react";
import AppLayout from "../AppLayout";
import CrimeMap from "../components/CrimeMap";
import TimelinePanel from "../components/TimelinePanel";
import type { TimelineMarker } from "../components/TimelinePanel";
import ComparisonBuilder from "../components/ComparisonBuilder";
import { useCrimeData } from "../hooks/useCrimeData";
import type { CrimeRecord } from "../hooks/useCrimeData";
import { useHotspots } from "../hooks/useHotspots";
import { useHotspotStore } from "../store/useHotspotStore";

const DashboardPage: React.FC = () => {
  const { data, loading, error } = useCrimeData(`${import.meta.env.BASE_URL}crimes.csv`);
  const { data: hotspotsData } = useHotspots();
  const { selectedItem } = useHotspotStore();
  const [filteredData, setFilteredData] = useState<CrimeRecord[] | null>(null);

  const handleFilter = useCallback((filtered: CrimeRecord[]) => {
    setFilteredData(filtered);
  }, []);

  // null = no filter applied, use all data
  const displayData = filteredData ?? data;

  // Mark the selected subgraph and its similar ones on the timeline so the
  // months they belong to are visible at a glance.
  const timelineMarkers = useMemo<TimelineMarker[]>(() => {
    if (!selectedItem || !hotspotsData) return [];
    const sel = hotspotsData[selectedItem.month]?.find((s) => s.rank === selectedItem.rank);
    if (!sel) return [];
    const out: TimelineMarker[] = [
      { month: selectedItem.month, rank: selectedItem.rank, kind: "selected" },
    ];
    for (const sim of sel.similarTo ?? []) {
      out.push({ month: sim.month, rank: sim.rank, kind: "similar" });
    }
    return out;
  }, [selectedItem, hotspotsData]);

  if (loading) {
    return (
      <AppLayout title="Urban Crime Dashboard" activePath="/">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#9ca3af", fontSize: 16 }}>
          Cargando datos...
        </div>
      </AppLayout>
    );
  }

  if (error) {
    return (
      <AppLayout title="Urban Crime Dashboard" activePath="/">
        <div style={{ padding: 20, color: "#ef4444" }}>Error: {error}</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout
      title="Urban Crime Dashboard"
      activePath="/"
      bottomPanel={<TimelinePanel data={data} onFilter={handleFilter} markers={timelineMarkers} />}
      rightPanel={<ComparisonBuilder />}
    >
      <CrimeMap data={displayData} />
    </AppLayout>
  );
};

export default DashboardPage;
