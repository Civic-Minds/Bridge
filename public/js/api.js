// API Module

export async function fetchState() {
    try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error('Failed to fetch state');
        return await res.json();
    } catch (e) {
        console.error("API Error:", e);
        return null;
    }
}

export async function fetchRecommendations() {
    try {
        const res = await fetch('/api/recommendations');
        if (!res.ok) throw new Error('Failed to fetch recommendations');
        return await res.json();
    } catch (e) {
        console.error("Recommendations API Error:", e);
        return null;
    }
}

export async function fetchPolicy() {
    try {
        const res = await fetch('/api/policy');
        if (!res.ok) throw new Error('Failed to fetch policy');
        return await res.json();
    } catch (e) {
        console.error("Policy API Error:", e);
        return null;
    }
}

export async function updatePolicy(policy) {
    try {
        const res = await fetch('/api/policy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(policy),
        });
        return await res.json();
    } catch (e) {
        console.error("Update Policy Error:", e);
        return null;
    }
}

export async function resetPolicy() {
    try {
        const res = await fetch('/api/policy/reset', { method: 'POST' });
        return await res.json();
    } catch (e) {
        console.error("Reset Policy Error:", e);
        return null;
    }
}

export async function fetchAvailableRoutes() {
    try {
        const agency = 'ttc';
        const res = await fetch(`/api/config/routes?a=${agency}`);
        return await res.json();
    } catch (e) {
        console.error("Route Config Error:", e);
        return [];
    }
}

export async function updateActiveRoutes(routes) {
    try {
        const res = await fetch('/api/config/active-routes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ routes })
        });
        return await res.json();
    } catch (e) {
        console.error("Update Config Error:", e);
        return null;
    }
}
