// Minimal on-screen UI (IMGUI, no packages needed) to test the full loop inside Unity:
// search the database → pick an office → watch the 3D route → see live room moves.
// Replace with your real UI Toolkit / uGUI screens later; the calls stay the same.
using System.Linq;
using UnityEngine;

namespace CityHallKiosk
{
    public class KioskDemoUI : MonoBehaviour
    {
        public NavigationController navigation;
        public float uiScale = 1.6f;

        string query = "";
        string status = "Loading data from the server…";
        float progress;
        Vector2 scroll;
        SearchResult lastSearch;

        void Start()
        {
            if (!navigation) navigation = FindObjectOfType<NavigationController>();
            navigation.OnStatus += s => status = s;
            navigation.OnProgress += p => progress = p;
            navigation.OnArrived += () => status = $"You have arrived at {navigation.ActiveRoomCode}.";
            DestinationRegistry.Instance.OnChanged += () =>
                status = $"Data v{DestinationRegistry.Instance.ContentVersion} · {DestinationRegistry.Instance.Destinations.Count} offices{(DestinationRegistry.Instance.IsOffline ? " · OFFLINE" : "")}";
        }

        void OnGUI()
        {
            GUI.matrix = Matrix4x4.Scale(new Vector3(uiScale, uiScale, 1));
            var reg = DestinationRegistry.Instance;
            GUILayout.BeginArea(new Rect(10, 10, 360, Screen.height / uiScale - 20), GUI.skin.box);
            GUILayout.Label("<b>Malaybalay City Hall — 3D prototype</b>", new GUIStyle(GUI.skin.label) { richText = true });
            GUILayout.Label(status, new GUIStyle(GUI.skin.label) { wordWrap = true });

            GUILayout.BeginHorizontal();
            query = GUILayout.TextField(query, GUILayout.MinWidth(200));
            if (GUILayout.Button("Search", GUILayout.Width(70)) && query.Trim().Length > 0)
                StartCoroutine(KioskApiClient.Instance.Search(query, r => lastSearch = r));
            GUILayout.EndHorizontal();

            if (navigation.IsNavigating || navigation.LastServerRoute != null && progress > 0)
            {
                GUILayout.HorizontalSlider(progress, 0f, 1f);
                GUILayout.BeginHorizontal();
                if (GUILayout.Button(navigation.Paused ? "Play" : "Pause")) navigation.Paused = !navigation.Paused;
                if (GUILayout.Button("Replay")) navigation.Replay();
                if (GUILayout.Button("Skip")) navigation.Skip();
                if (GUILayout.Button("End")) { navigation.Stop(); progress = 0; }
                GUILayout.EndHorizontal();
                var dirs = navigation.LastServerRoute?.directions;
                if (dirs != null) foreach (var d in dirs) GUILayout.Label("• " + d.text, new GUIStyle(GUI.skin.label) { wordWrap = true });
            }

            scroll = GUILayout.BeginScrollView(scroll);
            if (lastSearch?.results != null && lastSearch.results.Length > 0)
            {
                GUILayout.Label($"Results for “{lastSearch.query}”");
                foreach (var hit in lastSearch.results.Take(8))
                {
                    if (GUILayout.Button($"{hit.title}\n<size=10>{hit.subtitle}</size>", new GUIStyle(GUI.skin.button) { richText = true, alignment = TextAnchor.MiddleLeft, wordWrap = true }))
                    {
                        if (hit.kind == "service")
                            StartCoroutine(KioskApiClient.Instance.GetService(hit.id, s =>
                            {
                                if (s?.location != null && s.location.room_id > 0) navigation.NavigateToRoom(s.location.room_id);
                                else status = $"{s?.office_name} is not inside City Hall.";
                            }));
                        else if (hit.kind == "office") navigation.NavigateToOffice(hit.id);
                    }
                }
                GUILayout.Space(8);
            }
            if (reg != null)
            {
                GUILayout.Label("All offices (live from the database)");
                foreach (var d in reg.Destinations)
                    if (GUILayout.Button($"{d.office_name}  ·  {d.room_code}", new GUIStyle(GUI.skin.button) { alignment = TextAnchor.MiddleLeft, wordWrap = true }))
                        navigation.NavigateToRoom(d.room_id);
            }
            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }
    }
}
