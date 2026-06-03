import { useState, useEffect } from 'react';
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { calculateLeadScore, getSiteQuality } from '../lib/scoring';

export function useLeads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'leads'), orderBy('dateAdded', 'desc'));
    const unsubscribe = onSnapshot(q, snapshot => {
      setLeads(snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          // Always re-derive so scoring changes apply to existing leads
          leadScore: calculateLeadScore(data.websiteUrl),
          siteQuality: getSiteQuality(data.websiteUrl),
        };
      }));
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return { leads, loading };
}
