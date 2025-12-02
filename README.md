# PouchLog

A progressive web application (PWA) for tracking and analyzing nicotine pouch usage.

[Live Application](https://pouchlog.com) | [Privacy Policy](./privacy.html)

## About

PouchLog is an open-source tool designed for quantifying nicotine intake. It was created to provide a tracking solution without advertisements, paywalls, or unnecessary bloat. The application supports both passive tracking (logging consumption) and active reduction strategies (tapering plans).

## Features

*   **Progressive Web App:** The application is installable on iOS and Android devices, supports offline functionality, and behaves like a native application.
*   **Database:** Includes a pre-loaded dataset of common brands with accurate nicotine values (mg per pouch), alongside support for custom entries.
*   **Analytics:** Provides visual data visualization including daily trends, hourly heatmaps, and total nicotine consumption.
*   **Reduction Plans:** Implements algorithms for tapering usage, including linear reduction and weekly step-down strategies.
*   **Cloud Sync:** Optional synchronization across devices using Google Firebase.
*   **Cost Tracking:** Monitors financial expenditure related to usage.

## Technical Stack

The project emphasizes performance and maintainability by avoiding heavy frontend frameworks.

*   **Frontend:** Vanilla HTML5, CSS3 (CSS Variables, Grid/Flexbox), JavaScript (ES6 Modules).
*   **Backend:** Google Firebase (Authentication, Firestore Database).
*   **Serverless:** Firebase Cloud Functions (Node.js) for notifications and maintenance tasks.
*   **Visualization:** Chart.js library.
*   **Hosting:** GitHub Pages.

## Setup and Installation

Since this is a static web application utilizing Backend-as-a-Service, no build process is required.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/OndraDol/WebNicotinePouches.git
    ```

2.  **Run the application:**
    Open `index.html` in a modern web browser. For the best experience (including Service Worker functionality), serve the files using a local server (e.g., Live Server extension for VS Code or Python SimpleHTTPServer).

## Privacy and Data

This project is developed as a hobby initiative and is not a commercial product.

*   **Data Storage:** User data is stored in Google Cloud Firestore.
*   **Data Control:** Users have full control over their data and can permanently delete their account and history directly within the application settings.
*   **Tracking:** Minimal anonymous analytics (Google Analytics) are used for performance monitoring. No personal data is sold or shared.

## License

Distributed under the MIT License.
