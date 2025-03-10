import React from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useParams
} from 'react-router-dom'
import { Layout, message } from 'antd'
import { FaSpinner } from 'react-icons/fa'
import * as dwc from 'dicomweb-client'

import AppConfig, { ServerSettings, ErrorMessageSettings } from './AppConfig'
import CaseViewer from './components/CaseViewer'
import Header from './components/Header'
import InfoPage from './components/InfoPage'
import Worklist from './components/Worklist'

import { joinUrl } from './utils/url'
import { User, AuthManager } from './auth'
import OidcManager from './auth/OidcManager'
import DicomWebManager from './DicomWebManager'

function ParametrizedCaseViewer ({ client, user, app, config }: {
  client: DicomWebManager
  user?: User
  app: {
    name: string
    version: string
    uid: string
    organization?: string
  }
  config: AppConfig
}): JSX.Element {
  const { studyInstanceUID } = useParams()

  const enableAnnotationTools = !(config.disableAnnotationTools ?? false)
  const preload = config.preload ?? false
  return (
    <CaseViewer
      client={client}
      user={user}
      annotations={config.annotations}
      preload={preload}
      app={app}
      enableAnnotationTools={enableAnnotationTools}
      studyInstanceUID={studyInstanceUID}
    />
  )
}

interface AppProps {
  name: string
  homepage: string
  version: string
  config: AppConfig
}

interface AppState {
  client: DicomWebManager
  user?: User
  isLoading: boolean
  redirectTo?: string
  wasAuthSuccessful: boolean
  error?: ErrorMessageSettings
}

class App extends React.Component<AppProps, AppState> {
  private readonly auth?: AuthManager

  private readonly handleDICOMwebError = (
    error: dwc.api.DICOMwebClientError,
    serverSettings: ServerSettings
  ): void => {
    if (error.status === 401) {
      this.signIn()
    }
    if (error.status === 403) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      message.error('User is not authorized to access DICOMweb resources.')
    }
    if (serverSettings.errorMessages !== undefined) {
      serverSettings.errorMessages.forEach(
        ({ status, message }: ErrorMessageSettings) => {
          if (error.status === status) {
            this.setState({
              error: {
                status: error.status,
                message
              }
            })
          }
        }
      )
    }
  }

  constructor (props: AppProps) {
    super(props)

    console.info('instatiate app')
    console.info(`app is located at "${props.config.path}"`)
    const { protocol, host } = window.location
    const baseUri = `${protocol}//${host}`
    const appUri = joinUrl(props.config.path, baseUri)

    const oidcSettings = props.config.oidc
    if (oidcSettings !== undefined) {
      console.info(
        'app uses the following OIDC configuration: ',
        props.config.oidc
      )
      this.auth = new OidcManager(appUri, oidcSettings)
    }

    if (props.config.servers.length === 0) {
      throw Error('One server needs to be configured.')
    }
    console.info(
      'app uses the following DICOMweb server configuration: ',
      props.config.servers
    )

    this.handleServerSelection = this.handleServerSelection.bind(this)

    message.config({ duration: 5 })

    this.state = {
      client: new DicomWebManager({
        baseUri: baseUri,
        settings: props.config.servers,
        onError: this.handleDICOMwebError
      }),
      isLoading: true,
      wasAuthSuccessful: false
    }
  }

  handleServerSelection ({ url }: { url: string }): void {
    console.info('select DICOMweb server: ', url)
    const client = new DicomWebManager({
      baseUri: '',
      settings: [{
        id: 'tmp',
        url,
        read: true,
        write: false
      }],
      onError: this.handleDICOMwebError
    })
    client.updateHeaders(this.state.client.headers)
    this.setState({ client })
  }

  /**
   * Handle successful authentication event.
   *
   * Authorizes the DICOMweb client to access the DICOMweb server and directs
   * the user back to the App.
   *
   * @param user - Information about the user
   * @param authorization - Value of the "Authorization" HTTP header field
   */
  handleSignIn = ({ user, authorization }: {
    user: User
    authorization: string
  }): void => {
    console.info(
      `handle sign in of user "${user.name}" and ` +
      `update authorization token "${authorization}"`
    )
    const client = this.state.client
    client.updateHeaders({ Authorization: authorization })
    const storedPath = window.localStorage.getItem('slim_path')
    const storedSearch = window.localStorage.getItem('slim_search')
    if (storedPath != null) {
      const currentPath = window.location.pathname
      if (storedPath !== currentPath) {
        let path = storedPath
        if (storedSearch != null) {
          path += storedSearch
        }
        window.location.href = path
      }
    }
    window.localStorage.removeItem('slim_path')
    window.localStorage.removeItem('slim_search')
    this.setState({
      user: user,
      client: client
    })
  }

  signIn (): void {
    if (this.auth !== undefined) {
      console.info('try to sign in user')
      this.auth.signIn({ onSignIn: this.handleSignIn }).then(() => {
        console.info('sign-in was successful')
        this.setState({
          isLoading: false,
          wasAuthSuccessful: true
        })
      }).catch((error) => {
        console.error('sign-in failed ', error)
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        message.error('Could not sign-in user.')
        this.setState({
          isLoading: false,
          redirectTo: undefined,
          wasAuthSuccessful: false
        })
      })
    } else {
      this.setState({
        isLoading: false,
        redirectTo: undefined,
        wasAuthSuccessful: true
      })
    }
  }

  componentDidMount (): void {
    const path = window.localStorage.getItem('slim_path')
    if (path == null) {
      window.localStorage.setItem('slim_path', window.location.pathname)
      window.localStorage.setItem('slim_search', window.location.search)
    }
    this.signIn()
  }

  render (): React.ReactNode {
    const appInfo = {
      name: this.props.name,
      version: this.props.version,
      homepage: this.props.homepage,
      uid: '1.2.826.0.1.3680043.9.7433.1.5',
      organization: this.props.config.organization
    }

    const enableWorklist = !(
      this.props.config.disableWorklist ?? false
    )
    const enableServerSelection = (
      this.props.config.enableServerSelection ?? false
    )

    let worklist
    if (enableWorklist) {
      worklist = <Worklist client={this.state.client} />
    } else {
      worklist = <div>Worklist has been disabled.</div>
    }

    let isLogoutPossible = false
    let onLogout: () => void
    if (
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      this.props.config.oidc != null &&
      this.props.config.oidc.endSessionEndpoint != null
    ) {
      onLogout = (): void => {
        if (this.auth != null) {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          this.auth.signOut()
        }
      }
      isLogoutPossible = true
    } else {
      onLogout = () => {}
      isLogoutPossible = false
    }

    const layoutStyle = { height: '100vh' }
    const layoutContentStyle = { height: '100%' }

    if (this.state.redirectTo !== undefined) {
      return (
        <BrowserRouter basename={this.props.config.path}>
          <Navigate to={this.state.redirectTo} replace />
        </BrowserRouter>
      )
    } else if (this.state.isLoading) {
      return (
        <BrowserRouter basename={this.props.config.path}>
          <Layout style={layoutStyle}>
            <Header
              app={appInfo}
              user={this.state.user}
              showWorklistButton={false}
              onServerSelection={this.handleServerSelection}
              showServerSelectionButton={false}
            />
            <Layout.Content style={layoutContentStyle}>
              <FaSpinner />
            </Layout.Content>
          </Layout>
        </BrowserRouter>
      )
    } else if (!this.state.wasAuthSuccessful) {
      return (
        <InfoPage type='error' message='Sign-in failed.' />
      )
    } else if (this.state.error != null) {
      return (
        <InfoPage type='error' message={this.state.error.message} />
      )
    } else {
      return (
        <BrowserRouter basename={this.props.config.path}>
          <Routes>
            <Route
              path='/'
              element={
                <Layout style={layoutStyle}>
                  <Header
                    app={appInfo}
                    user={this.state.user}
                    showWorklistButton={false}
                    onServerSelection={this.handleServerSelection}
                    onUserLogout={isLogoutPossible ? onLogout : undefined}
                    showServerSelectionButton={enableServerSelection}
                  />
                  <Layout.Content style={layoutContentStyle}>
                    {worklist}
                  </Layout.Content>
                </Layout>
              }
            />
            <Route
              path='/studies/:studyInstanceUID/*'
              element={
                <Layout style={layoutStyle}>
                  <Header
                    app={appInfo}
                    user={this.state.user}
                    showWorklistButton={enableWorklist}
                    onServerSelection={this.handleServerSelection}
                    onUserLogout={isLogoutPossible ? onLogout : undefined}
                    showServerSelectionButton={enableServerSelection}
                  />
                  <Layout.Content style={layoutContentStyle}>
                    <ParametrizedCaseViewer
                      client={this.state.client}
                      user={this.state.user}
                      config={this.props.config}
                      app={appInfo}
                    />
                  </Layout.Content>
                </Layout>
              }
            />
            <Route
              path='/logout'
              element={
                <Layout style={layoutStyle}>
                  <Header
                    app={appInfo}
                    user={this.state.user}
                    showWorklistButton={false}
                    onServerSelection={this.handleServerSelection}
                    onUserLogout={isLogoutPossible ? onLogout : undefined}
                    showServerSelectionButton={enableServerSelection}
                  />
                  Logged out
                </Layout>
              }
            />
          </Routes>
        </BrowserRouter>
      )
    }
  }
}

export default App
