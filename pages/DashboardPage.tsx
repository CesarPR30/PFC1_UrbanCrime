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
  const { selectedItem, triggerFlyTo } = useHotspotStore();
  const [filteredData, setFilteredData] = useState<CrimeRecord[] | null>(null);

  const handleFilter = useCallback((filtered: CrimeRecord[]) => {
    setFilteredData(filtered);
  }, []);

  // Clicking a timeline marker just flies the map to that subgraph (it's already
  // drawn as part of the current selection) — same "look, don't re-select"
  // behaviour as clicking a row in the left candidate list.
  const handleMarkerClick = useCallback(
    (month: string, rank: number) => {
      const spot = hotspotsData?.[month]?.find((s) => s.rank === rank);
      if (spot?.center) triggerFlyTo(spot.center[0], spot.center[1]);
    },
    [hotspotsData, triggerFlyTo],
  );

  // null = no filter applied, use all data
  const displayData = filteredData ?? data;

  // Mark the selected subgraph and its similar ones on the timeline so the
  // months they belong to are visible at a glance.
  const timelineMarkers = useMemo<TimelineMarker[]>(() => {
    if (!selectedItem || !hotspotsData) return [];
    const sel = hotspotsData[selectedItem.month]?.find((s) => s.rank === selectedItem.rank);
    if (!sel) return [];
    // "R" tags the reference; the similars get "A", "B", … in similarity order,
    // matching the letters shown in the left-hand candidate list.
    const out: TimelineMarker[] = [
      { month: selectedItem.month, rank: selectedItem.rank, kind: "selected", label: "R" },
    ];
    (sel.similarTo ?? []).forEach((sim, i) => {
      out.push({
        month: sim.month,
        rank: sim.rank,
        kind: "similar",
        label: String.fromCharCode(65 + i), // 65 = "A"
      });
    });
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
      bottomPanel={<TimelinePanel data={data} onFilter={handleFilter} markers={timelineMarkers} onMarkerClick={handleMarkerClick} />}
      rightPanel={<ComparisonBuilder />}
    >
      <CrimeMap data={displayData} />
    </AppLayout>
  );
};

export default DashboardPage;
